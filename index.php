<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Shanghai');

function isLocalIp(string $ip): bool
{
    return in_array($ip, ['127.0.0.1', '::1'], true);
}

function isLocalHost(string $host): bool
{
    $sanitized = strtolower(trim($host));
    $sanitized = preg_replace('/:\\d+$/', '', $sanitized);
    $allowedHosts = ['localhost', '127.0.0.1'];
    return in_array($sanitized, $allowedHosts, true);
}

$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$hostHeader = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? '');
$isLocal = isLocalIp($remoteAddr) && isLocalHost($hostHeader);
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>噪音监控系统</title>
    <link rel="stylesheet" href="assets/style.css">
</head>
<body>
<header>
    <div class="time-display" id="beijing-time">
        <span class="time-date">--</span>
        <span class="time-value">--:--:--</span>
    </div>
    <div class="header-center">
        <h1>噪音监控系统</h1>
        <p>外部访问者仅可查看历史事件。</p>
    </div>
</header>

<section class="grid<?php echo $isLocal ? '' : ' grid-remote'; ?>">
    <?php if ($isLocal): ?>
        <article class="card" id="local-panel">
            <h2>实时监控</h2>
            <div class="monitor">
                <div class="current-db">
                    <span id="db-value">--</span>
                    <span class="unit">dB</span>
                </div>
                <canvas id="wave-canvas" width="600" height="200"></canvas>
            </div>
            <div class="controls">
                <label>
                    阈值设置
                    <input type="number" id="threshold-input" value="55" min="30" max="100" step="1">
                </label>
                <input type="range" id="threshold-slider" value="55" min="30" max="100" step="1">
                <label>
                    历史显示条数
                    <input type="number" id="history-limit-input" value="5" min="1" step="1">
                </label>
                <div class="control-row">
                    <button id="archive-btn" class="archive-button">📦 数据归档</button>
                    <button id="monitor-toggle">🎙️ 开始监听</button>
                </div>
            </div>
            <p class="hint">仅当本地访问时才会触发麦克风权限与事件上传。</p>
        </article>
    <?php endif; ?>

    <article class="card card--tabs" id="records-panel">
        <div class="tabs-header">
            <h2>噪音记录</h2>
            <div class="tabs-nav" role="tablist">
                <button class="tab-btn active" role="tab" data-tab-target="history" aria-controls="history-panel" aria-selected="true">📜 实时监听</button>
                <button class="tab-btn" role="tab" data-tab-target="favorites" aria-controls="favorites-panel" aria-selected="false" tabindex="-1">⭐ 收藏栏</button>
            </div>
        </div>
        <div class="tab-panel" data-tab-panel="history" role="tabpanel" id="history-panel">
            <div id="events-list" class="events-list"></div>
        </div>
        <div class="tab-panel" data-tab-panel="favorites" role="tabpanel" id="favorites-panel" hidden>
            <p class="panel-note">收藏的噪音事件会被永久保留，且不会随清理操作被删除。</p>
            <div id="favorites-list" class="favorites-list"></div>
        </div>
    </article>
</section>

<footer>
    <small>记录文件存放于服务器本地</small>
</footer>

<script src="summary.config.js"></script>
<script>
window.NOISE_MONITOR_SUMMARIES = window.NOISE_MONITOR_SUMMARIES || {};
window.NOISE_MONITOR_CONFIG = {
    isLocal: <?php echo $isLocal ? 'true' : 'false'; ?>,
    apiBase: 'api.php',
    favoriteSummaries: window.NOISE_MONITOR_SUMMARIES
};
</script>
<script src="assets/app.js" defer></script>
</body>
</html>
