# Repository Guidelines

## 项目结构与模块组织
- `index.php`：渲染监控面板，并仅向本地访客开放实时采集；保持服务端模板精简，把交互逻辑交给前端 JS。入口会注入 `window.NOISE_MONITOR_CONFIG`，请确保 key 命名与 `assets/app.js` 保持一致，避免 runtime error。
- `api.php`：集中处理日志、列表、删除、归档与收藏等 JSON 接口；新增路由时务必复用 `ensureLocalRequest()` 与现有存储助手。若需要新存储目录，先在 `config` 常量区集中声明，防止 magic path。
- `assets/`：`app.js` 管理浏览器端状态与事件流，`style.css` 负责整体样式；沿用当前原生技术栈即可。引入第三方库前，请评估 bundle 体积并记录在 PR checklist 中。
- 数据目录将录音保存在 `recordings/`，波形保存在 `waveforms/`，收藏副本保存在 `favorites/`，原始事件记录落在 `noise_events.log`；归档结果统一进入 `archives/`。命名统一使用 `event_YYYYMMDD_HHMMSS_xxxx`，便于追踪。
- `summary.config.js`：唯一的日期摘要配置文件，键格式固定为 `YYYY-MM-DD`；大批量更新时优先编写脚本生成，减少人工错漏。

## 构建、测试与开发命令
- `php -S 127.0.0.1:8080 -t .`：使用内置服务器本地运行整站，可配合 `php -d display_errors=1` 快速捕获 warning。
- `npm test`：当前占位命令，会立即失败；待引入真实测试后替换，可作为 CI smoke stage。
- `php -l api.php index.php`：提交前进行 PHP 语法快速检查，建议结合 `find . -name '*.php' -print0 | xargs -0 php -l` 扫描新增文件。

## 编码风格与命名约定
- PHP 文件启用 `strict_types=1`，使用四空格缩进、PSR-12 花括号风格，并坚持 snake_case 变量；已有的辅助函数可保持 camelCase 以兼容代码基因。新增工具函数时记得补充 phpdoc 以辅助 IDE。
- 业务规则留在 PHP 中，界面状态由 `assets/app.js` 接管；复用 `PRE_EVENT_MS` 等常量，避免散落 magic number。涉及多端逻辑时可创建 `config` 常量集合，保持共享。
- 模板输出需通过 `htmlspecialchars` 或既有工具函数进行转义，确保前端安全。若需输出富文本，请先在 API 层白名单化允许的标签。
- JavaScript 统一使用 `const`/`let`、四空格缩进与小而纯的工具函数，遵循当前模块拆分方式；复杂流程可拆分为 `hooks` 式 helper，方便 unit test。

## 测试指引
- 手工冒烟：启动 PHP 服务、触发一次录音，确认仪表盘与 `noise_events.log` 同步新增记录。必要时使用浏览器 DevTools 模拟高噪音，观察 event payload。
- 调整归档流程后，执行一次归档并检查 `archives/` 中是否生成可播放的媒体包，同时验证 `archives/*.zip` 的解压目录结构。
- 修改前端时，可临时改写 `summary.config.js` 的示例日期，刷新页面验证摘要渲染是否正确；建议在开发者工具中测试 favorites tab 切换性能。

## 提交与合并请求规范
- 提交主题使用祈使句现在时，例如 `Add waveform pruning for remote clients`，并在正文说明受影响的层级。必要时附上 `Before/After` 对比说明。
- 若有任务编号，正文首行引用；涉及数据迁移或清理的步骤需写清楚，便于复现。若引入脚本，请附 `php script.php --help` 输出示例。
- PR 描述列出验证步骤，界面改动附上截图或 GIF，同时标注需要同步的媒体目录或手工清理事项；当修改 API 行为时，附上 sample request/response。

## 安全与数据处理
- 所有会变更数据的接口必须保留 `ensureLocalRequest()` 校验，新功能也要共享该逻辑。远程只读功能需再次确认响应体不包含敏感字段。
- 录音与波形文件视为敏感数据，避免误提交到仓库，并确认 `.gitignore` 仍屏蔽二进制产物；分享调试包时，请通过 `zip --encrypt` 或其他安全方式传输。
- 分享排障信息前，请脱敏 `noise_events.log` 中可能暴露个人信息的 IP 与文件名；日志截取建议使用 `tail -n 50 noise_events.log | jq '.'`，确保格式统一。

## 环境配置与排障
- 推荐使用 macOS Sequoia 或同等环境，PHP 版本固定在 7.4，确保与生产一致；本地可开启 `xdebug.mode=develop` 以辅助断点调试。
- Redis、MySQL 与 Nginx 的配置样例请参考 `docs/` 目录（若缺失可在 PR 中补充），提交前请记录自定义端口以便他人复现。
- 常见问题：若浏览器提示麦克风权限被禁，请在 Safari/Chrome 中清除 `noise_monitor` 相关权限并重试；若归档失败，检查 `archives/` 是否具备写权限，以及磁盘空间是否足够。
