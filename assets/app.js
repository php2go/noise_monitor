(() => {
    const cfg = window.NOISE_MONITOR_CONFIG || {};
    const isLocal = Boolean(cfg.isLocal);
    const apiBase = cfg.apiBase || 'api.php';
    const favoriteSummaryMap = (cfg.favoriteSummaries && typeof cfg.favoriteSummaries === 'object')
        ? cfg.favoriteSummaries
        : {};
    const FAVORITE_SUMMARY_DEFAULT = '待分析总结';
    const PRE_EVENT_MS = 2000;
    const POST_EVENT_MS = 2000;
    const RECORDER_TIMESLICE = 500;
    const RECORDING_MIME = 'audio/webm;codecs=opus';
    const SILENCE_DURATION_MS = 800;  // 低于阈值持续0.8秒后才结束录音(适合短促声音)
    const HISTORY_LIMIT_DEFAULT = 5;
    const HISTORY_LIMIT_MIN = 1;

    const dom = {
        dbValue: document.getElementById('db-value'),
        thresholdInput: document.getElementById('threshold-input'),
        thresholdSlider: document.getElementById('threshold-slider'),
        toggleBtn: document.getElementById('monitor-toggle'),
        archiveBtn: document.getElementById('archive-btn'),
        canvas: document.getElementById('wave-canvas'),
        eventsList: document.getElementById('events-list'),
        historyPanel: document.getElementById('history-panel'),
        favoritesList: document.getElementById('favorites-list'),
        favoritesPanel: document.getElementById('favorites-panel'),
        tabButtons: document.querySelectorAll('[data-tab-target]'),
        tabPanels: document.querySelectorAll('[data-tab-panel]'),
        updateIndicator: null,
        historyLimitInput: document.getElementById('history-limit-input')
    };

    const canvasCtx = dom.canvas ? dom.canvas.getContext('2d') : null;

    const state = {
        isMonitoring: false,
        threshold: 55,
        stream: null,
        audioContext: null,
        analyser: null,
        dataArray: null,
        rafId: null,
        indicatorTimer: null,
        pollingTimer: null,
        lastSignature: null,
        lastEvents: [],  // 用于检测新增事件
        mediaRecorder: null,
        chunkHistory: [],
        captureRequest: null,
        gainNode: null,
        recorderDestination: null,
        silenceStartTime: 0,  // 开始静默的时间戳
        waveformFailures: new Set(),
        waveformSnapshots: new Map(),
        waveformResizeTimer: null,
        waveformResizeHandlerBound: false,
        recorderHeaderBlob: null,
        selectedEvents: new Map(),
        notificationAudioCtx: null,
        notificationUnlocked: false,
        notificationEnabled: false,
        latestEventTs: null,
        favoritesSignature: null,
        favorites: [],
        favoriteIdentifiers: new Set(),
        favoritesTimer: null,
        activeTab: 'history',
        historyLimit: HISTORY_LIMIT_DEFAULT,
        historyTotal: 0,
        favoriteGroupExpanded: new Set(),
        favoriteMediaLoaded: new Set(),
        favoriteLazyObserver: null
    };

    const init = () => {
        syncThresholdInputs(55);
        bindThresholdInputs();
        syncHistoryLimitInput(HISTORY_LIMIT_DEFAULT);
        bindHistoryLimitInput();
        bindMonitorButton();
        bindArchiveButton();
        setupUpdateIndicator();
        setupTabs();
        scheduleEventPolling();
        scheduleFavoritesPolling();
        setupWaveformResizeHandler();
        startBeijingTimeClock();
        setupAudioUnlock();
    };

    const startBeijingTimeClock = () => {
        const timeDisplay = document.getElementById('beijing-time');
        if (!timeDisplay) return;

        const updateTime = () => {
            const now = new Date();
            // 获取UTC时间并加8小时
            const beijingTime = new Date(now.getTime() + (now.getTimezoneOffset() * 60000) + (8 * 3600000));

            const year = beijingTime.getFullYear();
            const month = String(beijingTime.getMonth() + 1).padStart(2, '0');
            const day = String(beijingTime.getDate()).padStart(2, '0');
            const hours = String(beijingTime.getHours()).padStart(2, '0');
            const minutes = String(beijingTime.getMinutes()).padStart(2, '0');
            const seconds = String(beijingTime.getSeconds()).padStart(2, '0');

            const timeDate = timeDisplay.querySelector('.time-date');
            const timeValue = timeDisplay.querySelector('.time-value');

            if (timeDate) {
                timeDate.textContent = `${year}-${month}-${day}`;
            }
            if (timeValue) {
                timeValue.textContent = `${hours}:${minutes}:${seconds}`;
            }
        };

        updateTime();  // 立即更新一次
        setInterval(updateTime, 1000);  // 每秒更新
    };

    const bindThresholdInputs = () => {
        if (!dom.thresholdInput || !dom.thresholdSlider) {
            return;
        }
        dom.thresholdInput.addEventListener('input', evt => {
            const value = clampDb(Number(evt.target.value));
            syncThresholdInputs(value);
        });
        dom.thresholdSlider.addEventListener('input', evt => {
            const value = clampDb(Number(evt.target.value));
            syncThresholdInputs(value);
        });
    };

    const setupUpdateIndicator = () => {
        if (dom.updateIndicator || !dom.historyPanel || !dom.eventsList) {
            return;
        }
        const indicator = document.createElement('div');
        indicator.id = 'events-update-indicator';
        indicator.className = 'update-indicator';
        indicator.setAttribute('aria-live', 'polite');
        indicator.textContent = '历史列表已更新';
        dom.historyPanel.insertBefore(indicator, dom.eventsList);
        dom.updateIndicator = indicator;
    };

    const setupTabs = () => {
        if (!dom.tabButtons?.length || !dom.tabPanels?.length) {
            return;
        }
        dom.tabButtons.forEach(button => {
            if (button.dataset.tabListenerBound) {
                return;
            }
            button.addEventListener('click', () => {
                const target = button.dataset.tabTarget;
                if (target) {
                    setActiveTab(target);
                }
            });
            button.dataset.tabListenerBound = 'true';
        });
        const defaultTab = state.activeTab || dom.tabButtons[0]?.dataset.tabTarget || 'history';
        setActiveTab(defaultTab);
    };

    const setActiveTab = key => {
        if (!key) {
            return;
        }
        state.activeTab = key;
        dom.tabButtons?.forEach(button => {
            const isActive = button.dataset.tabTarget === key;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
            button.setAttribute('tabindex', isActive ? '0' : '-1');
        });
        dom.tabPanels?.forEach(panel => {
            const isActive = panel.dataset.tabPanel === key;
            panel.hidden = !isActive;
            panel.classList.toggle('active', isActive);
        });
        refreshWaveformSnapshots();
    };

    const syncThresholdInputs = value => {
        state.threshold = clampDb(value || 55);
        if (dom.thresholdInput) {
            dom.thresholdInput.value = state.threshold;
        }
        if (dom.thresholdSlider) {
            dom.thresholdSlider.value = state.threshold;
        }
    };

    const clampDb = value => {
        if (!Number.isFinite(value)) {
            return 55;
        }
        return Math.min(100, Math.max(30, Math.round(value)));
    };

    const clampHistoryLimit = value => {
        if (!Number.isFinite(value)) {
            return HISTORY_LIMIT_DEFAULT;
        }
        const rounded = Math.round(value);
        return Math.max(HISTORY_LIMIT_MIN, rounded || HISTORY_LIMIT_DEFAULT);
    };

    const syncHistoryLimitInput = value => {
        state.historyLimit = clampHistoryLimit(value ?? HISTORY_LIMIT_DEFAULT);
        if (dom.historyLimitInput) {
            dom.historyLimitInput.value = state.historyLimit;
        }
    };

    const bindHistoryLimitInput = () => {
        if (!dom.historyLimitInput) {
            return;
        }
        const handler = () => handleHistoryLimitChange(dom.historyLimitInput.value);
        dom.historyLimitInput.addEventListener('change', handler);
        dom.historyLimitInput.addEventListener('input', handler);
    };

    const handleHistoryLimitChange = rawValue => {
        const clamped = clampHistoryLimit(Number(rawValue));
        if (clamped !== state.historyLimit) {
            state.historyLimit = clamped;
            if (dom.historyLimitInput) {
                dom.historyLimitInput.value = state.historyLimit;
            }
            fetchEvents();
        } else if (dom.historyLimitInput) {
            dom.historyLimitInput.value = clamped;
        }
    };

    const bindMonitorButton = () => {
        if (!dom.toggleBtn) {
            return;
        }
        if (!isLocal) {
            dom.toggleBtn.disabled = true;
            dom.toggleBtn.textContent = '仅限本地使用';
            return;
        }
        dom.toggleBtn.addEventListener('click', () => {
            if (state.isMonitoring) {
                stopMonitoring();
            } else {
                startMonitoring();
            }
        });
    };

    const bindArchiveButton = () => {
        if (!dom.archiveBtn) {
            return;
        }
        if (!isLocal) {
            dom.archiveBtn.disabled = true;
            dom.archiveBtn.textContent = '仅限本地使用';
            return;
        }
        dom.archiveBtn.addEventListener('click', async () => {
            if (!confirm('确定要归档所有当前数据吗?\n\n归档后会创建一个压缩包,包含:\n- 所有录音文件\n- 所有波形图片\n- 事件日志文件\n\n归档不会删除原始数据。')) {
                return;
            }

            try {
                dom.archiveBtn.disabled = true;
                dom.archiveBtn.textContent = '📦 归档中...';

                const response = await fetch(`${apiBase}?action=archive`, {
                    method: 'POST'
                });

                const result = await response.json();

                if (!response.ok) {
                    throw new Error(result.error || '归档失败');
                }

                // 下载归档文件
                if (result.archive_url) {
                    const link = document.createElement('a');
                    link.href = result.archive_url;
                    link.download = result.filename || 'archive.zip';
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);

                    notify(`归档成功!\n文件: ${result.filename}\n大小: ${result.size}\n已清空 ${result.deleted_count || 0} 个原始文件`);
                } else {
                    notify('归档成功!');
                }

                // 刷新事件列表(显示为空)
                await fetchEvents();

            } catch (error) {
                notify('归档失败: ' + error.message);
            } finally {
                dom.archiveBtn.disabled = false;
                dom.archiveBtn.textContent = '📦 归档数据';
            }
        });
    };

    const startMonitoring = async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            notify('当前浏览器不支持麦克风调用');
            return;
        }
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = state.audioContext.createMediaStreamSource(state.stream);

            // 创建增益节点，将音量提高80% (增益值 1.8)
            state.gainNode = state.audioContext.createGain();
            state.gainNode.gain.value = 1.8;

            state.analyser = state.audioContext.createAnalyser();
            state.analyser.fftSize = 2048;
            state.dataArray = new Uint8Array(state.analyser.fftSize);

            // 音频路由: source -> gainNode -> analyser (仅用于可视化)
            source.connect(state.gainNode);
            state.gainNode.connect(state.analyser);

            startRecorder();
            state.isMonitoring = true;
            dom.toggleBtn.textContent = '⏹️ 停止监听';
            dom.toggleBtn.classList.add('monitoring');  // 添加红色样式
            renderFrame();
        } catch (error) {
            notify('麦克风授权失败：' + error.message);
        }
    };

    const stopMonitoring = () => {
        if (state.stream) {
            state.stream.getTracks().forEach(track => track.stop());
        }
        if (state.audioContext) {
            state.audioContext.close();
        }
        stopRecorder();
        cancelAnimationFrame(state.rafId);
        state.isMonitoring = false;
        dom.toggleBtn.textContent = '🎙️ 开始监听';
        dom.toggleBtn.classList.remove('monitoring');  // 移除红色样式,恢复绿色
        dom.dbValue.textContent = '--';
        clearCanvas();
    };

    const renderFrame = () => {
        if (!state.analyser || !state.dataArray) {
            return;
        }

        // 使用频率数据而非时域数据,更适合柱状图显示
        state.analyser.getByteFrequencyData(state.dataArray);
        drawBarChart(state.dataArray);

        // 仍然需要时域数据来计算分贝值
        const timeData = new Uint8Array(state.analyser.fftSize);
        state.analyser.getByteTimeDomainData(timeData);
        const dbValue = estimateDb(timeData);
        updateDbDisplay(dbValue);

        // 新的录音逻辑: 超过阈值开始录音,低于阈值持续一定时间后结束录音
        if (dbValue >= state.threshold) {
            // 超过阈值
            state.silenceStartTime = 0;  // 重置静默时间
            if (!state.captureRequest) {
                // 开始新的录音
                console.log(`🔴 触发录音! 分贝:${dbValue}, 阈值:${state.threshold}`);
                captureEvent(dbValue);
            } else if (!state.captureRequest.finishing) {
                // 正在录音中(未完成),继续收集
                // 减少日志噪音,只在整秒打印
                if (Date.now() - state.captureRequest.startTime > 0 &&
                    Math.floor((Date.now() - state.captureRequest.startTime) / 1000) !==
                    Math.floor((Date.now() - state.captureRequest.startTime - 16) / 1000)) {
                    console.log(`🟢 录音中... 分贝:${dbValue}, 已录 ${Math.floor((Date.now() - state.captureRequest.startTime) / 1000)}秒`);
                }
            }
        } else {
            // 低于阈值
            if (state.captureRequest && !state.captureRequest.finishing) {
                // 正在录音中(未完成)
                const now = Date.now();
                if (state.silenceStartTime === 0) {
                    // 刚开始静默
                    state.silenceStartTime = now;
                    console.log(`🟡 开始静默检测,分贝:${dbValue}`);
                } else {
                    // 检查静默时长
                    const silenceDuration = now - state.silenceStartTime;
                    if (silenceDuration >= SILENCE_DURATION_MS) {
                        // 静默时间足够,结束录音
                        console.log(`⚪ 静默${Math.round(silenceDuration)}ms,结束录音`);
                        finishCapture();
                    }
                }
            }
        }

        state.rafId = requestAnimationFrame(renderFrame);
    };

    const estimateDb = buffer => {
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i += 1) {
            const deviation = buffer[i] - 128;
            sumSquares += deviation * deviation;
        }
        const rms = Math.sqrt(sumSquares / buffer.length) / 128 || 0;
        const db = 20 * Math.log10(rms || 1e-8) + 90; // 粗略估算
        return Math.max(0, Math.min(120, Math.round(db)));
    };

    const updateDbDisplay = value => {
        if (dom.dbValue) {
            dom.dbValue.textContent = value.toString();
            dom.dbValue.classList.toggle('over-threshold', value >= state.threshold);
        }
    };

    // 绘制频谱柱状图
    const drawBarChart = buffer => {
        if (!canvasCtx || !dom.canvas) {
            return;
        }
        const { width, height } = dom.canvas;

        // 清空画布
        canvasCtx.fillStyle = '#0b0f16';
        canvasCtx.fillRect(0, 0, width, height);

        // 只显示低频到中频部分(人声范围),显示64个柱子
        const barCount = 64;
        const barWidth = width / barCount;
        const barGap = 2;

        for (let i = 0; i < barCount; i++) {
            // 从频率数据中取样
            const value = buffer[i];

            // 将值映射到高度(0-255 -> 0-height)
            const barHeight = (value / 255) * height;

            // 根据高度设置颜色(绿色到黄色到红色渐变)
            let fillColor;
            if (value < 85) {
                fillColor = '#3fb950';  // 绿色
            } else if (value < 170) {
                fillColor = '#f0ad4e';  // 黄色
            } else {
                fillColor = '#ff4444';  // 红色
            }

            canvasCtx.fillStyle = fillColor;
            canvasCtx.fillRect(
                i * barWidth,
                height - barHeight,
                barWidth - barGap,
                barHeight
            );
        }
    };

    // 为音频元素设置增益(放大音量)
    const setupAudioGain = (audioElement, gain_value) => {
        if (!audioElement || audioElement.dataset.gainSetup) {
            return;  // 避免重复设置
        }

        audioElement.dataset.gainSetup = 'true';

        audioElement.addEventListener('play', () => {
            try {
                const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                const source = audioContext.createMediaElementSource(audioElement);
                const gainNode = audioContext.createGain();

                gainNode.gain.value = gain_value;  // 设置增益值(2.0 = 200%)

                source.connect(gainNode);
                gainNode.connect(audioContext.destination);

                console.log(`🔊 音量增益已设置: ${gain_value * 100}%`);
            } catch (error) {
                // createMediaElementSource 只能调用一次,如果已经连接过会报错,忽略即可
                console.debug('音频上下文已连接:', error.message);
            }
        }, { once: true });  // 只在第一次播放时设置
    };

    const ensureCanvasResolution = canvas => {
        if (!canvas) {
            return { width: 0, height: 0 };
        }
        const parentRect = canvas.parentElement?.getBoundingClientRect();
        const ownRect = canvas.getBoundingClientRect();
        let width = Math.round((parentRect?.width || ownRect.width || 0));
        let height = Math.round((parentRect?.height || ownRect.height || 0));

        if (!width) {
            width = Number(canvas.dataset.renderWidth) || Number(canvas.getAttribute('width')) || 600;
        }
        if (!height) {
            height = Number(canvas.dataset.renderHeight) || Number(canvas.getAttribute('height')) || 180;
        }

        if (canvas.width !== width) {
            canvas.width = width;
        }
        if (canvas.height !== height) {
            canvas.height = height;
        }

        canvas.dataset.renderWidth = String(width);
        canvas.dataset.renderHeight = String(height);
        return { width, height };
    };

    const rememberWaveformSnapshot = (canvasId, audioElement, audioBuffer) => {
        if (!canvasId || !audioBuffer) {
            return;
        }
        state.waveformSnapshots.set(canvasId, {
            audio: audioElement,
            buffer: audioBuffer
        });
    };

    const getAudioProgress = audioElement => {
        if (!audioElement || !audioElement.duration || Number.isNaN(audioElement.duration) || !isFinite(audioElement.duration)) {
            return 0;
        }
        return audioElement.currentTime / audioElement.duration;
    };

    const refreshWaveformSnapshots = () => {
        if (!state.waveformSnapshots.size) {
            return;
        }
        state.waveformSnapshots.forEach((snapshot, canvasId) => {
            const canvas = document.getElementById(canvasId);
            if (!canvas) {
                state.waveformSnapshots.delete(canvasId);
                return;
            }
            drawAudioBufferWaveform(canvas, snapshot.buffer, getAudioProgress(snapshot.audio));
        });
    };

    const pruneWaveformSnapshots = () => {
        if (!state.waveformSnapshots.size) {
            return;
        }
        state.waveformSnapshots.forEach((_, canvasId) => {
            if (!document.getElementById(canvasId)) {
                state.waveformSnapshots.delete(canvasId);
            }
        });
    };

    const setupWaveformResizeHandler = () => {
        if (state.waveformResizeHandlerBound) {
            return;
        }
        state.waveformResizeHandlerBound = true;
        window.addEventListener('resize', () => {
            if (state.waveformResizeTimer) {
                clearTimeout(state.waveformResizeTimer);
            }
            state.waveformResizeTimer = setTimeout(() => {
                refreshWaveformSnapshots();
            }, 200);
        });
    };

    // 为音频设置波形可视化
    const setupAudioWaveform = async audioElement => {
        const eventId = audioElement.dataset.eventId || audioElement.dataset.favoriteId;
        const canvasId = audioElement.dataset.waveCanvasId || (eventId ? `wave-${eventId}` : '');
        if (!canvasId) {
            console.warn('音频元素缺少 eventId');
            return;
        }

        const canvas = document.getElementById(canvasId);
        if (!canvas) {
            console.warn(`找不到波形画布: ${canvasId}`);
            return;
        }
        ensureCanvasResolution(canvas);

        console.log(`📊 设置波形可视化: ${eventId}`);

        try {
            // 加载音频文件并解析波形数据
            const response = await fetch(audioElement.src);
            const arrayBuffer = await response.arrayBuffer();

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            state.waveformFailures.delete(eventId);

            console.log(`✅ 音频解析成功: 时长=${audioBuffer.duration.toFixed(2)}秒`);

            // 绘制完整波形
            drawAudioBufferWaveform(canvas, audioBuffer);
            audioContext.close();
            rememberWaveformSnapshot(canvasId, audioElement, audioBuffer);

            // 播放时高亮当前播放位置
            let animationId = null;
            const updateProgress = () => {
                if (!audioElement.duration || isNaN(audioElement.duration)) {
                    console.warn('音频时长无效');
                    return;
                }
                const progress = audioElement.currentTime / audioElement.duration;
                drawAudioBufferWaveform(canvas, audioBuffer, progress);
            };

            audioElement.addEventListener('play', () => {
                console.log('▶️ 播放开始');
                const animate = () => {
                    if (audioElement.paused || audioElement.ended) {
                        return;
                    }
                    updateProgress();
                    animationId = requestAnimationFrame(animate);
                };
                animate();
            });

            audioElement.addEventListener('pause', () => {
                console.log('⏸️ 播放暂停');
                if (animationId) {
                    cancelAnimationFrame(animationId);
                }
                updateProgress();
            });

            audioElement.addEventListener('ended', () => {
                console.log('⏹️ 播放结束');
                if (animationId) {
                    cancelAnimationFrame(animationId);
                }
                drawAudioBufferWaveform(canvas, audioBuffer, 0);  // 重置到开始
            });

            // 拖动进度条时同步波形
            audioElement.addEventListener('seeking', () => {
                console.log(`⏩ 拖动中: ${audioElement.currentTime.toFixed(2)}s`);
                if (animationId) {
                    cancelAnimationFrame(animationId);
                }
                updateProgress();
            });

            audioElement.addEventListener('seeked', () => {
                console.log(`✓ 拖动完成: ${audioElement.currentTime.toFixed(2)}s`);
                updateProgress();
            });

        } catch (error) {
            console.error('❌ 音频波形解析失败:', error);
            state.waveformFailures.add(eventId);
            state.waveformSnapshots.delete(canvasId);
            drawWaveformError(canvas, '波形加载失败');
        }
    };

    const drawWaveformError = (canvas, message = '波形加载失败') => {
        if (!canvas) {
            return;
        }
        const { width, height } = ensureCanvasResolution(canvas);
        if (!width || !height) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        ctx.fillStyle = '#0b0f16';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#ff4444';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(message, width / 2, height / 2);
    };

    // 绘制音频缓冲区的完整波形
    const drawAudioBufferWaveform = (canvas, audioBuffer, playProgress = 0) => {
        if (!canvas || !audioBuffer) {
            return;
        }
        const { width, height } = ensureCanvasResolution(canvas);
        if (!width || !height) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const channelData = audioBuffer.getChannelData(0);  // 使用第一声道

        // 清空画布
        ctx.fillStyle = '#0b0f16';
        ctx.fillRect(0, 0, width, height);

        // 计算采样间隔(将音频数据压缩到画布宽度)
        const step = Math.ceil(channelData.length / width);
        const amp = height / 2;

        // 绘制波形
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#3fb950';

        for (let i = 0; i < width; i++) {
            let min = 1.0;
            let max = -1.0;

            // 找到这个像素范围内的最大最小值
            for (let j = 0; j < step; j++) {
                const index = i * step + j;
                if (index >= channelData.length) break;
                const datum = channelData[index];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }

            const yMin = (1 + min) * amp;
            const yMax = (1 + max) * amp;

            if (i === 0) {
                ctx.moveTo(i, yMax);
            }
            ctx.lineTo(i, yMax);
            ctx.lineTo(i, yMin);
        }

        ctx.stroke();

        // 绘制播放进度线
        if (playProgress > 0 && playProgress < 1) {
            const progressX = width * playProgress;
            ctx.strokeStyle = '#58a6ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(progressX, 0);
            ctx.lineTo(progressX, height);
            ctx.stroke();
        }
    };

    const clearCanvas = () => {
        if (!canvasCtx || !dom.canvas) {
            return;
        }
        canvasCtx.fillStyle = '#0b0f16';
        canvasCtx.fillRect(0, 0, dom.canvas.width, dom.canvas.height);
    };

    const captureEvent = dbValue => {
        if (!state.mediaRecorder || state.captureRequest) {
            return;  // 已经在录音中或录音器未就绪
        }

        const preChunks = collectPreEventChunks();
        state.captureRequest = {
            dbValue,
            timestamp: new Date(),
            chunks: [...preChunks],
            startTime: Date.now()
        };
        console.log('🎙️ 开始录音,当前分贝:', dbValue);
    };

    const finishCapture = () => {
        if (!state.captureRequest) {
            return;
        }

        const duration = Date.now() - state.captureRequest.startTime;
        console.log(`🎙️ 结束录音,时长: ${Math.round(duration/1000)}秒, 等待最后的音频块...`);

        // 标记为正在完成,不再接受新的音频块
        state.captureRequest.finishing = true;
        const capture = state.captureRequest;

        // 等待至少一个timeslice,确保MediaRecorder发送最后的音频块
        setTimeout(() => {
            console.log(`📦 最终收集到 ${capture.chunks.length} 个音频块`);

            // 清理状态
            state.captureRequest = null;
            state.silenceStartTime = 0;

            processCapturedChunks(capture);
        }, RECORDER_TIMESLICE + 100);  // 500ms + 100ms缓冲
    };

    const sendEvent = body => {
        return fetch(`${apiBase}?action=log`, {
            method: 'POST',
            body
        }).then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.error || '记录失败');
                });
            }
            return response.json();
        });
    };

    const fetchEvents = async () => {
        try {
            const limit = clampHistoryLimit(state.historyLimit ?? HISTORY_LIMIT_DEFAULT);
            state.historyLimit = limit;
            if (dom.historyLimitInput) {
                dom.historyLimitInput.value = limit;
            }
            const res = await fetch(`${apiBase}?action=list&limit=${limit}`, { cache: 'no-store' });
            const data = await res.json();
            const totalCount = Number.isFinite(Number(data.total)) ? Number(data.total) : null;
            state.historyTotal = totalCount !== null && totalCount >= 0 ? totalCount : null;
            renderEvents(Array.isArray(data.events) ? data.events : []);
        } catch (error) {
            console.error('加载事件失败', error);
        }
    };

    const scheduleEventPolling = () => {
        fetchEvents();
        if (state.pollingTimer) {
            clearInterval(state.pollingTimer);
        }
        state.pollingTimer = setInterval(fetchEvents, 1000);
    };

    const fetchFavorites = async () => {
        if (!dom.favoritesList) {
            return;
        }
        try {
            const res = await fetch(`${apiBase}?action=favorites`, { cache: 'no-store' });
            const data = await res.json();
            renderFavorites(Array.isArray(data.favorites) ? data.favorites : []);
        } catch (error) {
            console.error('加载收藏失败', error);
        }
    };

    const scheduleFavoritesPolling = () => {
        fetchFavorites();
        if (state.favoritesTimer) {
            clearInterval(state.favoritesTimer);
        }
        state.favoritesTimer = setInterval(fetchFavorites, 5000);
    };

    const renderEvents = events => {
        if (!dom.eventsList) {
            return;
        }
        const prevSignature = state.lastSignature;
        const signature = JSON.stringify(events);
        const hasPrev = prevSignature !== null;
        const changed = signature !== prevSignature;
        if (hasPrev && !changed) {
            return;
        }

        const baselineTs = state.latestEventTs;
        const highlightIds = getHighlightIdentifiers(events, baselineTs);
        const hasNewerEvent = highlightIds.size > 0;

        state.lastSignature = signature;
        state.lastEvents = events;

        cleanupSelectionState(events);
        renderHistoryHeader(events.length);

        if (!events.length) {
            dom.eventsList.innerHTML = '<p class="hint">暂未检测到噪音事件。</p>';
        } else {
            dom.eventsList.innerHTML = events
                .map((event, index) => renderEventItem(
                    event,
                    highlightIds.has(getEventIdentifier(event)),
                    events.length - index
                ))
                .join('');

            // 为所有音频播放器设置音量并绑定波形动画
            const audioPlayers = dom.eventsList.querySelectorAll('audio.event-player');
            audioPlayers.forEach(audio => {
                // 注意: HTML5 audio的volume属性范围是0-1,但我们可以通过Web Audio API增益
                audio.volume = 1.0;  // 先设置为最大值

                // 强制加载元数据
                if (audio.readyState < 1) {
                    console.log(`⏳ 加载音频元数据: ${audio.src}`);
                    audio.load();  // 强制加载元数据
                }

                // 通过Web Audio API增大音量200%
                setupAudioGain(audio, 2.0);

                const eventId = audio.dataset.eventId;
                if (eventId && state.waveformFailures.has(eventId)) {
                    const canvas = document.getElementById(`wave-${eventId}`);
                    if (canvas) {
                        drawWaveformError(canvas, '波形加载失败');
                    }
                    return;
                }

                setupAudioWaveform(audio);
            });

            setupSelectionControls();
            syncSelectionCheckboxes();
            bindFavoriteButtons();
            syncFavoriteButtons();
        }
        pruneWaveformSnapshots();

        commitLatestEventTimestamp(events);

        if (baselineTs !== null && hasPrev && changed && hasNewerEvent) {
            showUpdateIndicator();
        }
    };

    const getHighlightIdentifiers = (events, baselineTs) => {
        const ids = new Set();
        if (baselineTs === null || !Array.isArray(events) || !events.length) {
            return ids;
        }
        events.forEach(event => {
            const ts = getEventTimestamp(event.time);
            if (ts !== null && ts > baselineTs) {
                const id = getEventIdentifier(event);
                if (id) {
                    ids.add(id);
                }
            }
        });
        return ids;
    };

    const commitLatestEventTimestamp = events => {
        const newest = getMaxEventTimestamp(events);
        if (newest === null) {
            return;
        }
        if (state.latestEventTs === null || newest > state.latestEventTs) {
            state.latestEventTs = newest;
        }
    };

    const getMaxEventTimestamp = events => {
        if (!Array.isArray(events) || !events.length) {
            return null;
        }
        let maxTs = null;
        events.forEach(event => {
            const ts = getEventTimestamp(event.time);
            if (ts !== null && (maxTs === null || ts > maxTs)) {
                maxTs = ts;
            }
        });
        return maxTs;
    };

    const getEventTimestamp = time => {
        if (!time || typeof time !== 'string') {
            return null;
        }
        let iso = time.trim().replace(' ', 'T');
        if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(iso)) {
            iso += '+08:00';
        }
        const ts = Date.parse(iso);
        return Number.isNaN(ts) ? null : ts;
    };
    
    const getEventIdentifier = event => {
        if (!event) {
            return '';
        }
        if (event.id) {
            return event.id;
        }
        const time = event.time || '';
        const db = Number.isFinite(event.db) ? event.db : '';
        return `${time}_${db}`;
    };

    const cleanupSelectionState = events => {
        if (!state.selectedEvents.size) {
            return;
        }
        const validIds = new Set(events.map(getEventIdentifier));
        for (const key of Array.from(state.selectedEvents.keys())) {
            if (!validIds.has(key)) {
                state.selectedEvents.delete(key);
            }
        }
    };

    const getCurrentEventCount = () => {
        return Array.isArray(state.lastEvents) ? state.lastEvents.length : 0;
    };

    const setupSelectionControls = () => {
        if (!isLocal || !dom.eventsList) {
            return;
        }
        const checkboxes = dom.eventsList.querySelectorAll('.event-select');
        checkboxes.forEach(checkbox => {
            const eventId = checkbox.dataset.eventId;
            if (!eventId) {
                return;
            }
            checkbox.checked = state.selectedEvents.has(eventId);
            if (!checkbox.dataset.listenerBound) {
                checkbox.addEventListener('change', () => {
                    const payloadStr = checkbox.dataset.payload || '';
                    let payload = null;
                    try {
                        payload = JSON.parse(decodeURIComponent(payloadStr));
                    } catch (error) {
                        console.warn('解析选择数据失败', error);
                    }
                    toggleEventSelection(eventId, payload, checkbox.checked);
                });
                checkbox.dataset.listenerBound = 'true';
            }
        });
    };

    const toggleEventSelection = (eventId, payload, checked) => {
        if (!eventId) {
            return;
        }
        if (checked) {
            if (!payload) {
                const fallback = (state.lastEvents || []).find(evt => getEventIdentifier(evt) === eventId);
                if (fallback) {
                    payload = {
                        time: fallback.time,
                        audio: fallback.audio,
                        waveform: fallback.waveform
                    };
                }
            }
            state.selectedEvents.set(eventId, payload || {});
        } else {
            state.selectedEvents.delete(eventId);
        }
        renderHistoryHeader(getCurrentEventCount());
    };

    const syncSelectionCheckboxes = () => {
        if (!isLocal || !dom.eventsList) {
            return;
        }
        dom.eventsList.querySelectorAll('.event-select').forEach(checkbox => {
            const eventId = checkbox.dataset.eventId;
            checkbox.checked = Boolean(eventId && state.selectedEvents.has(eventId));
        });
    };

    const handleSelectAll = () => {
        if (!isLocal || !Array.isArray(state.lastEvents)) {
            return;
        }
        state.lastEvents.forEach(event => {
            const eventId = getEventIdentifier(event);
            if (eventId) {
                state.selectedEvents.set(eventId, {
                    time: event.time,
                    audio: event.audio,
                    waveform: event.waveform
                });
            }
        });
        renderHistoryHeader(getCurrentEventCount());
        syncSelectionCheckboxes();
    };

    const handleClearSelection = () => {
        state.selectedEvents.clear();
        renderHistoryHeader(getCurrentEventCount());
        syncSelectionCheckboxes();
    };

    const handleFavorite = async (payloadStr, buttonEl, eventId) => {
        let payload = null;
        try {
            payload = JSON.parse(decodeURIComponent(payloadStr));
        } catch (error) {
            notify('收藏数据解析失败');
            return;
        }
        if (!payload) {
            return;
        }
        if (payload.db !== undefined) {
            const numericDb = Number(payload.db);
            payload.db = Number.isFinite(numericDb) ? numericDb : payload.db;
        }
        const originalText = buttonEl?.textContent;
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = '处理中...';
        }
        try {
            const response = await fetch(`${apiBase}?action=favorite`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || '收藏失败');
            }
            if (eventId) {
                state.favoriteIdentifiers.add(eventId);
            }
            if (buttonEl) {
                buttonEl.textContent = '✅ 已收藏';
            }
            syncFavoriteButtons();
            await fetchFavorites();
        } catch (error) {
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.textContent = originalText || '⭐ 收藏';
            }
            notify('收藏失败: ' + error.message);
        }
    };

    const bindFavoriteButtons = () => {
        if (!isLocal || !dom.eventsList) {
            return;
        }
        dom.eventsList.querySelectorAll('.favorite-btn').forEach(button => {
            if (button.dataset.listenerBound) {
                return;
            }
            button.addEventListener('click', () => {
                const payloadStr = button.dataset.payload || '';
                const eventId = button.dataset.eventId || '';
                handleFavorite(payloadStr, button, eventId);
            });
            button.dataset.listenerBound = 'true';
        });
    };

    const syncFavoriteButtons = () => {
        if (!isLocal || !dom.eventsList) {
            return;
        }
        dom.eventsList.querySelectorAll('.favorite-btn').forEach(button => {
            const eventId = button.dataset.eventId;
            if (!eventId) {
                return;
            }
            if (state.favoriteIdentifiers.has(eventId)) {
                button.disabled = true;
                button.textContent = '✅ 已收藏';
            } else {
                button.disabled = false;
                button.textContent = '⭐ 收藏';
            }
        });
    };

    const renderEventItem = (event, isNew = false, displayIndex = null) => {
        const time = event.time || '--';
        const db = event.db ?? '--';
        const waveform = event.waveform || '';
        const audio = event.audio || '';
        const eventId = getEventIdentifier(event);
        const sequence = typeof displayIndex === 'number' ? displayIndex : null;

        const audioTag = audio
            ? `<audio class="event-player" controls preload="metadata" src="${audio}" data-event-id="${eventId}"></audio>`
            : '<span class="event-player hint">音频缺失</span>';

        // 使用 canvas 显示动态波形图
        const waveformBlock = `<div class="wave-preview">
            <canvas class="wave-canvas" id="wave-${eventId}" width="600" height="180"></canvas>
        </div>`;

        const dbText = Number.isFinite(Number(db)) ? `${db}dB` : '--dB';

        // 构建事件数据用于删除
        const eventData = encodeURIComponent(JSON.stringify({ time, audio, waveform, db }));
        const selectionControl = isLocal
            ? `<label class="event-select-label">
                    <input type="checkbox" class="event-select" data-event-id="${eventId}" data-payload="${eventData}" ${state.selectedEvents.has(eventId) ? 'checked' : ''}>
                    <span>选中</span>
               </label>`
            : '';

        // 仅在本地访问时显示删除按钮
        const deleteButton = isLocal
            ? `<button class="delete-btn" onclick="window.deleteEvent('${eventData}')" title="删除此事件">✕</button>`
            : '';

        const favoriteButton = isLocal
            ? `<button class="favorite-btn" data-event-id="${eventId}" data-payload="${eventData}">⭐ 收藏</button>`
            : '';

        // 如果是新增的事件，添加 new-item 类
        const itemClass = isNew ? 'event-item new-item' : 'event-item';

        return `
            <div class="${itemClass}" data-event-id="${eventId}">
                <div class="event-meta">
                    ${selectionControl}
                    ${sequence ? `<span class="event-seq">#${String(sequence).padStart(2, '0')}</span>` : ''}
                    <div class="event-time">${time}</div>
                    <span class="db-pill">${dbText}</span>
                </div>
                ${waveformBlock}
                <div class="event-footer">
                    ${audioTag}
                    ${favoriteButton}
                    ${deleteButton}
                </div>
            </div>
        `;
    };

    const renderFavorites = favorites => {
        if (!dom.favoritesList) {
            return;
        }
        const signature = JSON.stringify(favorites);
        const hasPrev = state.favoritesSignature !== null;
        if (hasPrev && signature === state.favoritesSignature) {
            return;
        }
        state.favoritesSignature = signature;
        state.favorites = favorites;
        pruneFavoriteMediaState(favorites);

        if (!favorites.length) {
            dom.favoritesList.innerHTML = '<p class="hint">暂未添加收藏。</p>';
        } else {
            const groups = groupFavoritesByDate(favorites);
            syncFavoriteGroupExpansion(groups);
            if (state.favoriteLazyObserver) {
                state.favoriteLazyObserver.disconnect();
            }
            dom.favoritesList.innerHTML = groups
                .map(group => renderFavoriteGroup(group, state.favoriteGroupExpanded.has(group.key)))
                .join('');
            bindFavoriteGroupToggles();
            prepareFavoriteAudioElements();
            observeFavoriteItems(dom.favoritesList);
        }
        pruneWaveformSnapshots();

        const favoriteIds = new Set();
        favorites.forEach(item => {
            const fromSource = item.source_id;
            const fallback = getEventIdentifier(item);
            if (fromSource) {
                favoriteIds.add(fromSource);
            }
            if (fallback) {
                favoriteIds.add(fallback);
            }
        });
        state.favoriteIdentifiers = favoriteIds;
        syncFavoriteButtons();
        renderFavoritesSummary(favorites.length);
    };

    const renderFavoriteItem = favorite => {
        const sourceId = favorite.source_id || getEventIdentifier(favorite);
        const eventId = getFavoriteItemId(favorite) || sourceId;
        const time = favorite.time || '--';
        const dbValue = Number.isFinite(Number(favorite.db)) ? `${Number(favorite.db)}dB` : '--dB';
        const canvasId = `wave-fav-${eventId}`;
        const hasAudio = Boolean(favorite.audio);
        const waveformBlock = hasAudio
            ? `<div class="wave-preview">
                    <canvas class="wave-canvas" id="${canvasId}" width="600" height="180"></canvas>
               </div>`
            : '<div class="wave-preview wave-preview--empty">音频缺失</div>';
        const audioTag = hasAudio
            ? `<audio class="event-player" controls preload="none" data-event-id="${eventId}" data-wave-canvas-id="${canvasId}" data-audio-src="${favorite.audio}"></audio>`
            : '<span class="event-player hint">音频缺失</span>';

        return `
            <div class="favorite-item" data-favorite-id="${eventId}" data-source-id="${sourceId}">
                <div class="favorite-meta">
                    <div class="favorite-time">${time}</div>
                    <span class="db-pill">${dbValue}</span>
                </div>
                ${waveformBlock}
                <div class="favorite-footer">
                    ${audioTag}
                </div>
            </div>
        `;
    };

    const getFavoriteItemId = favorite => {
        if (!favorite) {
            return '';
        }
        if (favorite.id) {
            return favorite.id;
        }
        if (favorite.source_id) {
            return favorite.source_id;
        }
        return getEventIdentifier(favorite);
    };

    const getFavoriteDateInfo = time => {
        if (typeof time !== 'string' || !time.trim()) {
            return { key: 'unknown', label: '未知日期', timestamp: 0 };
        }
        const sanitized = time.trim();
        let datePart = sanitized.slice(0, 10);
        let timestamp = Date.parse(`${datePart}T00:00:00`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart) || Number.isNaN(timestamp)) {
            const parsed = Date.parse(sanitized);
            if (!Number.isNaN(parsed)) {
                const d = new Date(parsed);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                datePart = `${year}-${month}-${day}`;
                timestamp = Date.parse(`${datePart}T00:00:00`);
            } else {
                datePart = 'unknown';
                timestamp = 0;
            }
        }
        return {
            key: datePart,
            label: datePart === 'unknown' ? '未知日期' : datePart,
            timestamp: Number.isNaN(timestamp) ? 0 : timestamp
        };
    };

    const getFavoriteTimestamp = time => {
        if (typeof time !== 'string' || !time.trim()) {
            return 0;
        }
        const parsed = Date.parse(time.trim());
        return Number.isNaN(parsed) ? 0 : parsed;
    };

    const groupFavoritesByDate = favorites => {
        const groupsMap = new Map();
        favorites.forEach(item => {
            const info = getFavoriteDateInfo(item.time);
            if (!groupsMap.has(info.key)) {
                groupsMap.set(info.key, {
                    key: info.key,
                    label: info.label,
                    timestamp: info.timestamp,
                    items: []
                });
            }
            groupsMap.get(info.key).items.push(item);
        });
        return Array.from(groupsMap.values())
            .map(group => {
                group.items.sort((a, b) => getFavoriteTimestamp(b.time) - getFavoriteTimestamp(a.time));
                return group;
            })
            .sort((a, b) => b.timestamp - a.timestamp);
    };

    const getFavoriteSummaryText = key => {
        if (!key) {
            return FAVORITE_SUMMARY_DEFAULT;
        }
        const preset = favoriteSummaryMap[key];
        return typeof preset === 'string' && preset.trim().length
            ? preset
            : FAVORITE_SUMMARY_DEFAULT;
    };

    const renderFavoriteGroup = (group, expanded = false) => {
        const summaryText = group.summary || getFavoriteSummaryText(group.key);
        const bodyContent = group.items.map(renderFavoriteItem).join('');
        const ariaExpanded = expanded ? 'true' : 'false';
        const hiddenAttr = expanded ? '' : 'hidden';
        return `
            <section class="favorite-group" data-group-key="${group.key}">
                <button type="button" class="favorite-group-header" data-group-key="${group.key}" aria-expanded="${ariaExpanded}">
                    <div class="favorite-group-header-text">
                        <span class="favorite-group-date">${group.label}</span>
                        <span class="favorite-group-count">${group.items.length} 条</span>
                    </div>
                    <span class="favorite-group-icon" aria-hidden="true"></span>
                </button>
                <div class="favorite-group-body" ${hiddenAttr}>
                    <div class="favorite-group-summary" aria-live="polite">${summaryText}</div>
                    ${bodyContent}
                </div>
            </section>
        `;
    };

    const bindFavoriteGroupToggles = () => {
        if (!dom.favoritesList) {
            return;
        }
        dom.favoritesList.querySelectorAll('.favorite-group-header').forEach(button => {
            if (button.dataset.listenerBound) {
                return;
            }
            button.addEventListener('click', () => {
                const key = button.dataset.groupKey;
                toggleFavoriteGroup(key);
            });
            button.dataset.listenerBound = 'true';
        });
    };

    const toggleFavoriteGroup = key => {
        if (!key || !dom.favoritesList) {
            return;
        }
        const groupEl = Array.from(dom.favoritesList.querySelectorAll('.favorite-group'))
            .find(el => el.dataset.groupKey === key);
        if (!groupEl) {
            return;
        }
        const header = groupEl.querySelector('.favorite-group-header');
        const body = groupEl.querySelector('.favorite-group-body');
        if (!header || !body) {
            return;
        }
        const isExpanded = header.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
            header.setAttribute('aria-expanded', 'false');
            body.setAttribute('hidden', '');
            state.favoriteGroupExpanded.delete(key);
        } else {
            header.setAttribute('aria-expanded', 'true');
            body.removeAttribute('hidden');
            state.favoriteGroupExpanded.add(key);
            observeFavoriteItems(body);
            refreshWaveformSnapshots();
        }
    };

    const syncFavoriteGroupExpansion = groups => {
        const validKeys = new Set(groups.map(group => group.key));
        Array.from(state.favoriteGroupExpanded).forEach(key => {
            if (!validKeys.has(key)) {
                state.favoriteGroupExpanded.delete(key);
            }
        });
    };

    const prepareFavoriteAudioElements = () => {
        if (!dom.favoritesList) {
            return;
        }
        dom.favoritesList.querySelectorAll('audio.event-player').forEach(audio => {
            audio.volume = 1.0;
            setupAudioGain(audio, 2.0);
            if (!audio.dataset.lazyBound) {
                audio.addEventListener('play', () => {
                    const itemEl = audio.closest('.favorite-item');
                    loadFavoriteItemMedia(itemEl);
                });
                audio.dataset.lazyBound = 'true';
            }
        });
    };

    const ensureFavoriteLazyObserver = () => {
        if (state.favoriteLazyObserver) {
            return true;
        }
        if (typeof IntersectionObserver === 'undefined') {
            return false;
        }
        state.favoriteLazyObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    loadFavoriteItemMedia(entry.target);
                    state.favoriteLazyObserver?.unobserve(entry.target);
                }
            });
        }, {
            root: null,
            rootMargin: '80px 0px',
            threshold: 0.2
        });
        return true;
    };

    const observeFavoriteItems = (container = dom.favoritesList) => {
        if (!container) {
            return;
        }
        const hasObserver = ensureFavoriteLazyObserver();
        container.querySelectorAll('.favorite-item').forEach(item => {
            const eventId = item.dataset.favoriteId;
            if (!eventId || state.favoriteMediaLoaded.has(eventId)) {
                return;
            }
            if (hasObserver) {
                state.favoriteLazyObserver.observe(item);
            } else {
                loadFavoriteItemMedia(item);
            }
        });
    };

    const loadFavoriteItemMedia = itemEl => {
        if (!itemEl) {
            return;
        }
        const eventId = itemEl.dataset.favoriteId;
        if (!eventId || state.favoriteMediaLoaded.has(eventId)) {
            return;
        }
        const audio = itemEl.querySelector('audio.event-player');
        const audioSrc = audio?.dataset.audioSrc || '';
        if (audio && audioSrc) {
            if (audio.src !== audioSrc) {
                audio.src = audioSrc;
            }
            try {
                audio.load();
            } catch (error) {
                console.warn('音频加载失败', error);
            }
            setupAudioWaveform(audio);
        } else {
            state.favoriteMediaLoaded.add(eventId);
            return;
        }
        state.favoriteMediaLoaded.add(eventId);
    };

    const pruneFavoriteMediaState = favorites => {
        if (!state.favoriteMediaLoaded.size) {
            return;
        }
        const validIds = new Set();
        favorites.forEach(item => {
            const id = getFavoriteItemId(item);
            if (id) {
                validIds.add(id);
            }
        });
        Array.from(state.favoriteMediaLoaded).forEach(id => {
            if (!validIds.has(id)) {
                state.favoriteMediaLoaded.delete(id);
            }
        });
    };

    const renderFavoritesSummary = count => {
        if (!dom.favoritesPanel) {
            return;
        }
        let summary = dom.favoritesPanel.querySelector('.favorites-summary');
        if (!summary) {
            summary = document.createElement('div');
            summary.className = 'favorites-summary';
            const note = dom.favoritesPanel.querySelector('.panel-note');
            if (note) {
                note.insertAdjacentElement('afterend', summary);
            } else if (dom.favoritesPanel.firstChild) {
                dom.favoritesPanel.insertBefore(summary, dom.favoritesPanel.firstChild);
            } else {
                dom.favoritesPanel.appendChild(summary);
            }
        }
        summary.textContent = `共有 ${count} 条`;
    };

    const notify = message => {
        console.warn(message);
        alert(message);
    };

    function renderHistoryHeader(count) {
        const panel = document.getElementById('history-panel');
        if (!panel) {
            return;
        }
        let wrapper = panel.querySelector('.bulk-actions');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.className = 'bulk-actions';
            const heading = panel.querySelector('h2');
            if (heading) {
                heading.insertAdjacentElement('afterend', wrapper);
            } else {
                panel.insertBefore(wrapper, panel.firstChild);
            }
        }
        wrapper.dataset.locked = 'true';
        const selectedCount = state.selectedEvents.size;
        const showLocalControls = isLocal;
        const totalSaved = typeof state.historyTotal === 'number' && state.historyTotal >= 0
            ? state.historyTotal
            : null;
        wrapper.innerHTML = `
            <div class="bulk-info">
                <button class="bulk-btn" id="notification-toggle-btn">
                    ${state.notificationEnabled ? '🔕 关闭提醒' : '🔔 启用提醒'}
                </button>
                <div class="bulk-info-text">
                    <span class="bulk-count">已显示 ${count} 条</span>
                    ${showLocalControls ? `<span class="bulk-selected">已选 ${selectedCount} 条</span>` : ''}
                    ${totalSaved !== null ? `<span class="bulk-total">已保存 ${totalSaved} 条</span>` : ''}
                </div>
            </div>
            <div class="bulk-buttons">
                ${showLocalControls ? `
                    <button class="bulk-btn" id="select-all-btn" ${count ? '' : 'disabled'}>✅ 全选</button>
                    <button class="bulk-btn" id="clear-selection-btn" ${selectedCount ? '' : 'disabled'}>🧹 清除选择</button>
                    <button class="delete-btn delete-btn--danger" id="bulk-delete-btn" ${selectedCount ? '' : 'disabled'}>
                        🗑️ 删除选中 (${selectedCount})
                    </button>
                ` : ''}
            </div>
        `;

        wrapper.querySelector('#notification-toggle-btn')?.addEventListener('click', () => {
            if (state.notificationEnabled) {
                disableNotificationSound();
            } else {
                enableNotificationSound();
            }
        });
        updateNotificationToggleVisual();
        if (showLocalControls) {
            wrapper.querySelector('#select-all-btn')?.addEventListener('click', handleSelectAll);
            wrapper.querySelector('#clear-selection-btn')?.addEventListener('click', handleClearSelection);
            wrapper.querySelector('#bulk-delete-btn')?.addEventListener('click', handleBulkDelete);
        }
    }

    const updateNotificationToggleVisual = () => {
        const button = document.getElementById('notification-toggle-btn');
        if (button) {
            button.textContent = state.notificationEnabled ? '🔕 关闭提醒' : '🔔 启用提醒';
        }
    };

    async function handleBulkDelete() {
        if (!state.selectedEvents.size) {
            return;
        }
        if (!confirm(`确定要删除选中的 ${state.selectedEvents.size} 条噪音事件吗？\n对应录音与波形将一并删除。`)) {
            return;
        }
        try {
            const response = await fetch(`${apiBase}?action=delete_many`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items: Array.from(state.selectedEvents.values()) })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || '批量删除失败');
            }
            state.selectedEvents.clear();
            renderHistoryHeader(getCurrentEventCount());
            await fetchEvents();
        } catch (error) {
            notify('批量删除失败: ' + error.message);
        }
    }

    const deleteEvent = async eventDataStr => {
        try {
            const eventData = JSON.parse(decodeURIComponent(eventDataStr));

            if (!confirm(`确定要删除 ${eventData.time} 的噪音事件吗?\n将同时删除录音文件和波形图片。`)) {
                return;
            }

            const response = await fetch(`${apiBase}?action=delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(eventData)
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || '删除失败');
            }

            await fetchEvents();  // 刷新列表
        } catch (error) {
            notify('删除失败: ' + error.message);
        }
    };

    // 暴露删除函数到全局作用域
    window.deleteEvent = deleteEvent;

    const showUpdateIndicator = () => {
        if (!dom.updateIndicator) {
            return;
        }
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
        dom.updateIndicator.innerHTML = `
            <span class="update-icon">🔔</span>
            <span class="update-text">新的噪音事件已记录</span>
            <span class="update-time">${time}</span>
        `;
        dom.updateIndicator.classList.add('visible');

        // 添加闪烁动画
        dom.updateIndicator.classList.add('flash');
        setTimeout(() => {
            dom.updateIndicator?.classList.remove('flash');
        }, 600);

        clearTimeout(state.indicatorTimer);
        state.indicatorTimer = setTimeout(() => {
            dom.updateIndicator?.classList.remove('visible');
        }, 3000);  // 延长显示时间到3秒

        if (state.notificationEnabled) {
            playNotificationSound();
        }
    };

    const setupAudioUnlock = () => {
        if (state.notificationUnlocked) {
            return;
        }
        const handler = () => {
            enableNotificationSound(true).finally(() => {
                document.removeEventListener('pointerdown', handler);
                document.removeEventListener('touchstart', handler);
            });
        };
        document.addEventListener('pointerdown', handler);
        document.addEventListener('touchstart', handler);
    };

    const ensureNotificationAudioContext = async () => {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) {
            throw new Error('当前环境不支持 AudioContext');
        }
        if (!state.notificationAudioCtx) {
            state.notificationAudioCtx = new AudioCtx();
        }
        if (state.notificationAudioCtx.state === 'suspended') {
            await state.notificationAudioCtx.resume();
        }
        return state.notificationAudioCtx;
    };

    const enableNotificationSound = async (silent = false) => {
        try {
            await ensureNotificationAudioContext();
            state.notificationUnlocked = true;
            state.notificationEnabled = true;
            updateNotificationToggleVisual();
        } catch (error) {
            if (!silent) {
                notify('无法启用声音提醒: ' + error.message);
            } else {
                console.debug('无法启用声音提醒', error);
            }
        }
    };

    const disableNotificationSound = () => {
        state.notificationEnabled = false;
        updateNotificationToggleVisual();
    };

    const playNotificationSound = () => {
        ensureNotificationAudioContext()
            .then(ctx => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'triangle';
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                gain.gain.setValueAtTime(0.0001, ctx.currentTime);
                gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + 0.35);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start();
                osc.stop(ctx.currentTime + 0.4);
                osc.addEventListener('ended', () => {
                    osc.disconnect();
                    gain.disconnect();
                });
            })
            .catch(error => {
                console.debug('播放提醒音失败', error);
            });
    };

    const startRecorder = () => {
        if (state.mediaRecorder || !state.stream) {
            return;  // 如果已经有录音器或没有音频流，直接返回
        }

        // 直接使用原始麦克风流进行录音(增益仅用于可视化)
        // 尝试多种兼容格式,优先使用 webm/opus 以避免解码兼容性问题
        let mimeType = '';
        const supportedTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4'  // 仅在其它格式不可用时作为回退
        ];

        for (const type of supportedTypes) {
            if (MediaRecorder.isTypeSupported(type)) {
                mimeType = type;
                console.log('✅ 使用录音格式:', type);
                break;
            }
        }

        if (!mimeType) {
            console.warn('⚠️ 没有找到支持的MIME类型,使用浏览器默认格式');
        }

        try {
            if (mimeType) {
                state.mediaRecorder = new MediaRecorder(state.stream, { mimeType });
            } else {
                state.mediaRecorder = new MediaRecorder(state.stream);
                console.log('使用浏览器默认录音格式');
            }
        } catch (error) {
            console.error('MediaRecorder创建失败:', error);
            state.mediaRecorder = new MediaRecorder(state.stream);
        }

        console.log('MediaRecorder实际格式:', state.mediaRecorder.mimeType);
        state.chunkHistory = [];
        state.mediaRecorder.addEventListener('dataavailable', handleRecorderData);
        state.mediaRecorder.addEventListener('error', handleRecorderError);
        state.mediaRecorder.start(RECORDER_TIMESLICE);
    };

    const stopRecorder = () => {
        if (!state.mediaRecorder) {
            return;
        }
        state.mediaRecorder.removeEventListener('dataavailable', handleRecorderData);
        state.mediaRecorder.removeEventListener('error', handleRecorderError);
        try {
            if (state.mediaRecorder.state !== 'inactive') {
                state.mediaRecorder.stop();
            }
        } catch (error) {
            console.error('Stop recorder failed', error);
        }
        state.mediaRecorder = null;
        state.chunkHistory = [];
        state.captureRequest = null;
        state.recorderHeaderBlob = null;
    };

    const handleRecorderError = event => {
        console.error('MediaRecorder error', event.error);
    };

    const handleRecorderData = event => {
        if (!event.data || !event.data.size) {
            return;
        }
        const chunkEntry = { blob: event.data, isHeader: false };
        if (!state.recorderHeaderBlob) {
            state.recorderHeaderBlob = event.data.slice(0);  // 保存初始化块
            chunkEntry.isHeader = true;
        }
        state.chunkHistory.push(chunkEntry);
        trimChunkHistory();

        // 如果正在录音,持续收集音频块(包括finishing状态)
        if (state.captureRequest && !state.captureRequest.finishing) {
            state.captureRequest.chunks.push(chunkEntry);
            // 只在块数是5的倍数时打印,减少日志噪音
            if (state.captureRequest.chunks.length % 5 === 0) {
                console.log(`🎵 收集音频块 #${state.captureRequest.chunks.length}, 大小: ${Math.round(event.data.size/1024)}KB`);
            }
        } else if (state.captureRequest && state.captureRequest.finishing) {
            // finishing状态下仍然收集最后的块
            state.captureRequest.chunks.push(chunkEntry);
            console.log(`🎵 收集最后的音频块 #${state.captureRequest.chunks.length}, 大小: ${Math.round(event.data.size/1024)}KB`);
        }
    };

    const trimChunkHistory = () => {
        const maxChunks = Math.ceil((PRE_EVENT_MS + POST_EVENT_MS + 4000) / RECORDER_TIMESLICE);
        while (state.chunkHistory.length > maxChunks) {
            state.chunkHistory.shift();
        }
    };

    const collectPreEventChunks = () => {
        const needed = Math.ceil(PRE_EVENT_MS / RECORDER_TIMESLICE);
        if (!state.chunkHistory.length) {
            return [];
        }
        return state.chunkHistory.slice(-needed);
    };

    const processCapturedChunks = async capture => {
        if (!capture || !capture.chunks.length) {
            console.warn('⚠️ 录音块为空,跳过保存');
            return;
        }
        const blobs = capture.chunks.map(entry => entry.blob);
        const hasHeader = capture.chunks.some(entry => entry?.isHeader);
        if (!hasHeader && state.recorderHeaderBlob) {
            console.log('🧩 缺少容器头,自动补齐');
            blobs.unshift(state.recorderHeaderBlob);
        } else if (!hasHeader) {
            console.warn('⚠️ 未找到容器头且无法补齐,音频可能无法解析');
        }
        const mime = state.mediaRecorder?.mimeType || RECORDING_MIME;
        const audioBlob = new Blob(blobs, { type: mime });

        console.log(`📦 处理录音: ${capture.chunks.length}个块, 总大小:${Math.round(audioBlob.size/1024)}KB`);
        console.log(`🎬 MIME类型: ${mime}`);
        console.log(`📊 Blob详情:`, {
            size: audioBlob.size,
            type: audioBlob.type,
            chunkSizes: capture.chunks.map(c => c.blob.size)
        });

        // 跳过可播放性检测,直接保存
        // 原因: MediaRecorder生成的音频应该总是有效的,短音频的检测可能失败导致误报
        console.log('✅ 准备上传录音文件');

        const waveformBlob = dom.canvas ? dataUrlToBlob(dom.canvas.toDataURL('image/png')) : null;
        const formData = new FormData();
        formData.append('timestamp', getShanghaiTimestamp(capture.timestamp));
        formData.append('db', String(capture.dbValue));
        const normalized = await normalizeAudioBlob(audioBlob, mime);
        const finalMime = normalized.mime;
        const finalBlob = normalized.blob;
        if (normalized.duration) {
            console.log(`🎧 归一化音频完成,时长≈${normalized.duration.toFixed(2)}秒,格式:${finalMime}`);
        }
        const audioExtension = getExtensionFromMime(finalMime);
        formData.append('audio_file', finalBlob, `noise_clip.${audioExtension}`);
        if (waveformBlob) {
            formData.append('waveform_file', waveformBlob, 'waveform.png');
        }

        try {
            await sendEvent(formData);
            await fetchEvents();
        } catch (error) {
            notify('上传事件失败：' + error.message);
        }
    };

    const dataUrlToBlob = dataUrl => {
        const parts = dataUrl.split(';base64,');
        const contentType = parts[0].split(':')[1];
        const raw = window.atob(parts[1]);
        const rawLength = raw.length;
        const uInt8Array = new Uint8Array(rawLength);
        
        for (let i = 0; i < rawLength; ++i) {
            uInt8Array[i] = raw.charCodeAt(i);
        }
        
        return new Blob([uInt8Array], { type: contentType });
    };

    const normalizeAudioBlob = async (blob, fallbackMime) => {
        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            audioContext.close();
            const wavBuffer = audioBufferToWav(audioBuffer);
            return {
                blob: new Blob([wavBuffer], { type: 'audio/wav' }),
                mime: 'audio/wav',
                duration: audioBuffer.duration
            };
        } catch (error) {
            console.warn('音频归一化失败,使用原始Blob', error);
            return {
                blob,
                mime: blob.type || fallbackMime || 'audio/webm',
                duration: null
            };
        }
    };

    const audioBufferToWav = audioBuffer => {
        const numChannels = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const channelData = [];
        for (let i = 0; i < numChannels; i += 1) {
            channelData.push(audioBuffer.getChannelData(i));
        }
        const interleaved = interleaveChannelData(channelData);
        const dataLength = interleaved.length * 2;
        const buffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(buffer);
        /* RIFF identifier */
        writeString(view, 0, 'RIFF');
        /* file length */
        view.setUint32(4, 36 + dataLength, true);
        /* RIFF type */
        writeString(view, 8, 'WAVE');
        /* format chunk identifier */
        writeString(view, 12, 'fmt ');
        /* format chunk length */
        view.setUint32(16, 16, true);
        /* sample format (raw) */
        view.setUint16(20, 1, true);
        /* channel count */
        view.setUint16(22, numChannels, true);
        /* sample rate */
        view.setUint32(24, sampleRate, true);
        /* byte rate (sample rate * block align) */
        view.setUint32(28, sampleRate * numChannels * 2, true);
        /* block align (channel count * bytes per sample) */
        view.setUint16(32, numChannels * 2, true);
        /* bits per sample */
        view.setUint16(34, 16, true);
        /* data chunk identifier */
        writeString(view, 36, 'data');
        /* data chunk length */
        view.setUint32(40, dataLength, true);

        floatTo16BitPCM(view, 44, interleaved);
        return buffer;
    };

    const interleaveChannelData = channels => {
        if (channels.length === 1) {
            return channels[0];
        }
        const length = channels[0].length;
        const result = new Float32Array(length * channels.length);
        let offset = 0;
        for (let i = 0; i < length; i += 1) {
            for (let channel = 0; channel < channels.length; channel += 1) {
                result[offset] = channels[channel][i];
                offset += 1;
            }
        }
        return result;
    };

    const floatTo16BitPCM = (view, offset, input) => {
        for (let i = 0; i < input.length; i += 1, offset += 2) {
            const s = Math.max(-1, Math.min(1, input[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
    };

    const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i += 1) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };

    const getExtensionFromMime = mime => {
        if (!mime) {
            return 'webm';
        }
        if (mime.includes('ogg')) {
            return 'ogg';
        }
        if (mime.includes('webm')) {
            return 'webm';
        }
        if (mime.includes('wav')) {
            return 'wav';
        }
        if (mime.includes('mp3')) {
            return 'mp3';
        }
        if (mime.includes('mp4')) {
            return 'm4a';
        }
        return mime.split('/').pop() || 'webm';
    };
    
    const getShanghaiTimestamp = date => {
        // 转换为东八区(北京时间) UTC+8
        const offset = 8 * 60; // 8小时 = 480分钟
        const localDate = new Date(date.getTime() + offset * 60 * 1000);
        // 格式: 2025-10-25T15:06:31+08:00
        const isoString = localDate.toISOString().replace('Z', '+08:00');
        return isoString;
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
