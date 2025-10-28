<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Shanghai');

$baseDir = __DIR__;
$logFile = $baseDir . '/noise_events.log';
$recordingDir = $baseDir . '/recordings';
$waveformDir = $baseDir . '/waveforms';
$favoritesDir = $baseDir . '/favorites';
$favoritesLog = $favoritesDir . '/favorites.log';
$favoriteRecordingDir = $favoritesDir . '/recordings';
$favoriteWaveformDir = $favoritesDir . '/waveforms';

header('Content-Type: application/json; charset=UTF-8');

$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    switch ($method . ':' . $action) {
        case 'GET:favorites':
            respondSuccess(['favorites' => listFavorites($favoritesLog)]);
            break;
        case 'GET:list':
            $listResult = listEvents($logFile);
            respondSuccess([
                'events' => $listResult['events'] ?? [],
                'total' => $listResult['total'] ?? 0
            ]);
            break;
        case 'POST:log':
            ensureLocalRequest();
            if (!empty($_FILES)) {
                $entry = persistEventFromUpload($_POST, $_FILES, $recordingDir, $waveformDir, $logFile);
            } else {
                $payload = decodeJsonPayload();
                $entry = persistEventFromPayload($payload, $recordingDir, $waveformDir, $logFile);
            }
            respondSuccess(['saved' => $entry]);
            break;
        case 'POST:delete':
            ensureLocalRequest();
            $payload = decodeJsonPayload();
            deleteEvent($payload, $baseDir, $logFile);
            respondSuccess(['deleted' => true]);
            break;
        case 'POST:delete_many':
            ensureLocalRequest();
            $payload = decodeJsonPayload();
            $items = $payload['items'] ?? [];
            if (!is_array($items) || empty($items)) {
                throw new RuntimeException('Missing items to delete', 422);
            }
            $deletedCount = deleteMultipleEvents($items, $baseDir, $logFile);
            respondSuccess(['deleted' => $deletedCount]);
            break;
        case 'POST:delete_all':
            ensureLocalRequest();
            $deleted = deleteAllEvents($recordingDir, $waveformDir, $logFile);
            respondSuccess(['deleted' => $deleted]);
            break;
        case 'POST:archive':
            ensureLocalRequest();
            $result = archiveAllData($baseDir, $recordingDir, $waveformDir, $logFile);
            respondSuccess($result);
            break;
        case 'POST:favorite':
            ensureLocalRequest();
            $payload = decodeJsonPayload();
            $favorite = addFavorite($payload, $baseDir, $favoritesLog, $favoriteRecordingDir, $favoriteWaveformDir);
            respondSuccess(['favorite' => $favorite]);
            break;
        default:
            http_response_code(404);
            echo json_encode(['error' => 'Unsupported route']);
    }
} catch (Throwable $e) {
    http_response_code($e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 500);
    echo json_encode(['error' => $e->getMessage()]);
}

function listEvents(string $logFile, int $defaultLimit = 5): array
{
    if (!is_file($logFile)) {
        return ['events' => [], 'total' => 0];
    }

    $limit = isset($_GET['limit']) ? max(1, (int) $_GET['limit']) : $defaultLimit;
    $allLines = @file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $total = count($allLines);
    $lines = $limit >= $total ? $allLines : array_slice($allLines, -$limit);

    $events = [];
    foreach ($lines as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded)) {
            $events[] = $decoded;
        }
    }

    return [
        'events' => array_reverse($events),
        'total' => $total
    ];
}

function persistEventFromPayload(array $payload, string $recordingDir, string $waveformDir, string $logFile): array
{
    $timestamp = $payload['timestamp'] ?? '';
    $dbValue = isset($payload['db']) ? (float) $payload['db'] : null;
    $audioUri = $payload['audio_data'] ?? '';
    $waveformUri = $payload['waveform_data'] ?? '';

    if ($audioUri === '' || $waveformUri === '') {
        throw new RuntimeException('Missing audio or waveform payload', 422);
    }

    if ($dbValue === null || $dbValue <= 0) {
        throw new RuntimeException('Invalid decibel value', 422);
    }

    $dt = normalizeTimestamp($timestamp);

    $slug = 'event_' . $dt->format('Ymd_His') . '_' . bin2hex(random_bytes(2));

    [$audioPath, $audioRelative] = saveDataUri($audioUri, $recordingDir, $slug, ['audio/webm' => 'webm', 'audio/wav' => 'wav']);
    [$waveformPath, $waveformRelative] = saveDataUri($waveformUri, $waveformDir, $slug, ['image/png' => 'png']);

    $entry = [
        'time' => $dt->format('Y-m-d H:i:s'),
        'db' => round($dbValue, 2),
        'audio' => $audioRelative,
        'waveform' => $waveformRelative,
    ];

    appendLogEntry($entry, $logFile);

    return $entry;
}

function decodeJsonPayload(): array
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Invalid JSON payload', 400);
    }
    return $data;
}

function saveDataUri(string $dataUri, string $directory, string $basename, array $mimeMap): array
{
    if (!preg_match('#^data:([\w/+.-]+)(;[\w=+-]+)*;base64,(.+)$#', $dataUri, $matches)) {
        throw new RuntimeException('Invalid data URI', 422);
    }

    $mime = strtolower($matches[1]);
    $base64 = preg_replace('/\s+/', '', $matches[3]);
    $base64 = strtr($base64, '-_', '+/');
    $binary = base64_decode($base64, true);
    if ($binary === false) {
        throw new RuntimeException('Invalid base64 data', 422);
    }

    $ext = $mimeMap[$mime] ?? explode('/', $mime)[1] ?? 'bin';
    $relative = basename($directory) . '/' . $basename . '.' . $ext;
    $path = dirname($directory) . '/' . $relative;

    if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to prepare storage directory');
    }

    if (@file_put_contents($path, $binary, LOCK_EX) === false) {
        throw new RuntimeException('Unable to write file');
    }

    return [$path, $relative];
}

function persistEventFromUpload(array $post, array $files, string $recordingDir, string $waveformDir, string $logFile): array
{
    $timestamp = $post['timestamp'] ?? '';
    $dbValue = isset($post['db']) ? (float) $post['db'] : null;

    if ($dbValue === null || $dbValue <= 0) {
        throw new RuntimeException('Invalid decibel value', 422);
    }

    if (empty($files['audio_file']) || empty($files['waveform_file'])) {
        throw new RuntimeException('Missing uploaded files', 422);
    }

    $dt = normalizeTimestamp($timestamp);
    $slug = 'event_' . $dt->format('Ymd_His') . '_' . bin2hex(random_bytes(2));

    [$audioPath, $audioRelative] = saveUploadedFile($files['audio_file'], $recordingDir, $slug, [
        'audio/mp4' => 'm4a',
        'audio/webm' => 'webm',
        'audio/wav' => 'wav',
        'audio/ogg' => 'ogg',
    ], 'webm');

    [$waveformPath, $waveformRelative] = saveUploadedFile($files['waveform_file'], $waveformDir, $slug, [
        'image/png' => 'png',
        'image/webp' => 'webp',
    ], 'png');

    $entry = [
        'time' => $dt->format('Y-m-d H:i:s'),
        'db' => round($dbValue, 2),
        'audio' => $audioRelative,
        'waveform' => $waveformRelative,
    ];

    appendLogEntry($entry, $logFile);

    return $entry;
}

function saveUploadedFile(array $file, string $directory, string $basename, array $mimeMap, string $defaultExt = 'bin'): array
{
    if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_OK) !== UPLOAD_ERR_OK || empty($file['tmp_name'])) {
        throw new RuntimeException('Upload failed', 422);
    }

    $tmpName = $file['tmp_name'];
    if (!is_uploaded_file($tmpName)) {
        throw new RuntimeException('Invalid upload source', 422);
    }

    $mime = strtolower((string) ($file['type'] ?? ''));
    // 移除MIME类型中的参数 (如 audio/mp4;codecs=opus -> audio/mp4)
    $mimeBase = explode(';', $mime)[0];
    $ext = $mimeMap[$mimeBase] ?? $mimeMap[$mime] ?? strtolower((string) pathinfo($file['name'] ?? '', PATHINFO_EXTENSION)) ?: $defaultExt;
    $ext = preg_replace('/[^a-z0-9]/', '', $ext) ?: $defaultExt;

    $relative = basename($directory) . '/' . $basename . '.' . $ext;
    $path = dirname($directory) . '/' . $relative;

    if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to prepare storage directory');
    }

    if (!move_uploaded_file($tmpName, $path)) {
        throw new RuntimeException('Unable to move uploaded file', 500);
    }

    return [$path, $relative];
}

function normalizeTimestamp(?string $timestamp): DateTimeImmutable
{
    if ($timestamp) {
        try {
            return new DateTimeImmutable($timestamp);
        } catch (Exception $e) {
            // fall through
        }
    }

    return new DateTimeImmutable('now');
}

function appendLogEntry(array $entry, string $logFile): void
{
    $jsonLine = json_encode($entry, JSON_UNESCAPED_SLASHES);
    if ($jsonLine === false) {
        throw new RuntimeException('Failed to encode log entry');
    }

    if (@file_put_contents($logFile, $jsonLine . PHP_EOL, FILE_APPEND | LOCK_EX) === false) {
        throw new RuntimeException('Unable to write log file');
    }
}

function ensureLocalRequest(): void
{
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $host = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? '');
    if (!isLocalIp($ip) || !isLocalHost($host)) {
        throw new RuntimeException('Microphone upload allowed only from localhost', 403);
    }
}

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

function respondSuccess(array $payload): void
{
    http_response_code(200);
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
}

function deleteEvent(array $payload, string $baseDir, string $logFile): void
{
    $time = $payload['time'] ?? '';
    $audioPath = $payload['audio'] ?? '';
    $waveformPath = $payload['waveform'] ?? '';

    if (empty($time)) {
        throw new RuntimeException('Missing event time', 422);
    }

    // 删除音频文件
    if ($audioPath) {
        $fullAudioPath = $baseDir . '/' . $audioPath;
        if (file_exists($fullAudioPath)) {
            @unlink($fullAudioPath);
        }
    }

    // 删除波形图片
    if ($waveformPath) {
        $fullWaveformPath = $baseDir . '/' . $waveformPath;
        if (file_exists($fullWaveformPath)) {
            @unlink($fullWaveformPath);
        }
    }

    // 从日志文件中删除对应行
    if (file_exists($logFile)) {
        $lines = file($logFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        $newLines = [];

        foreach ($lines as $line) {
            $event = json_decode($line, true);
            if (is_array($event) && ($event['time'] ?? '') !== $time) {
                $newLines[] = $line;
            }
        }

        file_put_contents($logFile, implode(PHP_EOL, $newLines) . (count($newLines) > 0 ? PHP_EOL : ''));
    }
}

function deleteMultipleEvents(array $items, string $baseDir, string $logFile): int
{
    $deleted = 0;
    foreach ($items as $item) {
        if (!is_array($item)) {
            continue;
        }
        deleteEvent($item, $baseDir, $logFile);
        $deleted++;
    }
    return $deleted;
}

function deleteAllEvents(string $recordingDir, string $waveformDir, string $logFile): array
{
    $audioDeleted = deleteFilesByExtensions($recordingDir, ['webm', 'wav', 'ogg', 'm4a', 'mp3']);
    $waveDeleted = deleteFilesByExtensions($waveformDir, ['png', 'jpg', 'jpeg', 'webp']);
    $logCleared = false;

    if (file_exists($logFile)) {
        $logCleared = @unlink($logFile);
    }

    return [
        'audio_deleted' => $audioDeleted,
        'waveform_deleted' => $waveDeleted,
        'log_cleared' => $logCleared,
    ];
}

function deleteFilesByExtensions(string $directory, array $extensions): int
{
    if (!is_dir($directory)) {
        return 0;
    }
    $pattern = rtrim($directory, " /\\") . '/*.{'. implode(',', $extensions) . '}';
    $files = glob($pattern, GLOB_BRACE) ?: [];
    $count = 0;
    foreach ($files as $file) {
        if (is_file($file) && @unlink($file)) {
            $count++;
        }
    }
    return $count;
}

function archiveAllData(string $base_dir, string $recording_dir, string $waveform_dir, string $log_file): array
{
    // 检查 ZipArchive 扩展
    if (!class_exists('ZipArchive')) {
        throw new Exception('服务器未安装 ZipArchive 扩展', 500);
    }

    // 创建归档目录
    $archive_dir = $base_dir . '/archives';
    if (!is_dir($archive_dir)) {
        mkdir($archive_dir, 0755, true);
    }

    // 生成归档文件名(包含时间戳)
    $timestamp = date('Y-m-d_His');
    $filename = "noise_archive_{$timestamp}.zip";
    $archive_path = $archive_dir . '/' . $filename;

    $zip = new ZipArchive();
    if ($zip->open($archive_path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
        throw new Exception('无法创建归档文件', 500);
    }

    $file_count = 0;

    // 添加日志文件
    if (file_exists($log_file)) {
        $zip->addFile($log_file, 'noise_events.log');
        $file_count++;
    }

    // 添加所有录音文件
    if (is_dir($recording_dir)) {
        $recordings = glob($recording_dir . '/*.{webm,mp3,wav,ogg}', GLOB_BRACE);
        foreach ($recordings as $file) {
            $zip->addFile($file, 'recordings/' . basename($file));
            $file_count++;
        }
    }

    // 添加所有波形图片
    if (is_dir($waveform_dir)) {
        $waveforms = glob($waveform_dir . '/*.{png,jpg,jpeg}', GLOB_BRACE);
        foreach ($waveforms as $file) {
            $zip->addFile($file, 'waveforms/' . basename($file));
            $file_count++;
        }
    }

    // 添加归档信息文件
    $info = "噪音监控系统数据归档\n";
    $info .= "归档时间: " . date('Y-m-d H:i:s') . "\n";
    $info .= "文件总数: {$file_count}\n";
    $info .= "归档版本: 1.0\n";
    $zip->addFromString('README.txt', $info);

    $zip->close();

    // 获取文件大小
    $size_bytes = filesize($archive_path);
    $size_mb = round($size_bytes / 1024 / 1024, 2);
    $size_text = $size_mb >= 1 ? "{$size_mb} MB" : round($size_bytes / 1024, 2) . " KB";

    // 归档成功后,清空所有原始数据
    $deleted_count = 0;

    // 删除日志文件
    if (file_exists($log_file)) {
        unlink($log_file);
        $deleted_count++;
    }

    // 删除所有录音文件
    if (is_dir($recording_dir)) {
        $recordings = glob($recording_dir . '/*.{webm,mp3,wav,ogg}', GLOB_BRACE);
        foreach ($recordings as $file) {
            unlink($file);
            $deleted_count++;
        }
    }

    // 删除所有波形图片
    if (is_dir($waveform_dir)) {
        $waveforms = glob($waveform_dir . '/*.{png,jpg,jpeg}', GLOB_BRACE);
        foreach ($waveforms as $file) {
            unlink($file);
            $deleted_count++;
        }
    }

    return [
        'success' => true,
        'filename' => $filename,
        'archive_url' => 'archives/' . $filename,
        'size' => $size_text,
        'file_count' => $file_count,
        'deleted_count' => $deleted_count,
        'timestamp' => $timestamp
    ];
}

function listFavorites(string $favoritesLog): array
{
    if (!is_file($favoritesLog)) {
        return [];
    }

    $lines = @file($favoritesLog, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $favorites = [];

    foreach ($lines as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded)) {
            if (empty($decoded['source_id']) && isset($decoded['time'])) {
                $db = isset($decoded['db']) ? (float) $decoded['db'] : null;
                $decoded['source_id'] = buildEventSourceId($decoded['time'], $db);
            }
            $favorites[] = $decoded;
        }
    }

    return array_reverse($favorites);
}

function addFavorite(array $payload, string $baseDir, string $favoritesLog, string $favoriteRecordingDir, string $favoriteWaveformDir): array
{
    $time = trim((string) ($payload['time'] ?? ''));
    $db = isset($payload['db']) ? (float) $payload['db'] : null;
    $audioPath = trim((string) ($payload['audio'] ?? ''));
    $waveformPath = trim((string) ($payload['waveform'] ?? ''));

    if ($time === '') {
        throw new RuntimeException('Missing event time', 422);
    }
    if ($db === null || $db <= 0) {
        throw new RuntimeException('Invalid decibel value', 422);
    }
    if ($audioPath === '' && $waveformPath === '') {
        throw new RuntimeException('Missing event assets', 422);
    }

    $identifier = sha1($time . '|' . $audioPath . '|' . $db);
    $sourceId = buildEventSourceId($time, $db);
    $existing = findFavoriteById($favoritesLog, $identifier);
    if ($existing) {
        if (empty($existing['source_id'])) {
            $existing['source_id'] = buildEventSourceId($time, $db);
        }
        return $existing;
    }

    $copiedAudio = $audioPath !== '' ? copyFavoriteAsset($audioPath, $baseDir, $favoriteRecordingDir) : '';
    $copiedWaveform = $waveformPath !== '' ? copyFavoriteAsset($waveformPath, $baseDir, $favoriteWaveformDir) : '';

    $entry = [
        'id' => $identifier,
        'time' => $time,
        'db' => round($db, 2),
        'audio' => $copiedAudio,
        'waveform' => $copiedWaveform,
        'source_audio' => $audioPath,
        'source_waveform' => $waveformPath,
        'source_id' => $sourceId,
        'favorited_at' => date('Y-m-d H:i:s'),
    ];

    appendFavoriteEntry($entry, $favoritesLog);

    return $entry;
}

function buildEventSourceId(string $time, ?float $db): string
{
    $dbPart = $db === null ? '' : normalizeDbValue($db);
    return trim($time) . '_' . $dbPart;
}

function normalizeDbValue(float $db): string
{
    // 避免浮点精度问题, 保留最多4位小数并去掉多余0
    $roundedInt = round($db);
    if (abs($db - $roundedInt) < 1e-6) {
        return (string) (int) $roundedInt;
    }
    $formatted = number_format($db, 4, '.', '');
    return rtrim(rtrim($formatted, '0'), '.');
}

function appendFavoriteEntry(array $entry, string $favoritesLog): void
{
    ensureDirectory(dirname($favoritesLog));
    $jsonLine = json_encode($entry, JSON_UNESCAPED_SLASHES);
    if ($jsonLine === false) {
        throw new RuntimeException('Failed to encode favorite entry');
    }
    if (@file_put_contents($favoritesLog, $jsonLine . PHP_EOL, FILE_APPEND | LOCK_EX) === false) {
        throw new RuntimeException('Unable to write favorites log');
    }
}

function ensureDirectory(string $directory): void
{
    if (is_dir($directory)) {
        return;
    }
    if (!mkdir($directory, 0775, true) && !is_dir($directory)) {
        throw new RuntimeException('Unable to prepare storage directory');
    }
}

function copyFavoriteAsset(string $relativeSourcePath, string $baseDir, string $targetDir): string
{
    if ($relativeSourcePath === '') {
        return '';
    }
    if (strpos($relativeSourcePath, '..') !== false) {
        throw new RuntimeException('Invalid asset path', 422);
    }
    $sourcePath = $baseDir . '/' . ltrim($relativeSourcePath, '/');
    if (!is_file($sourcePath)) {
        throw new RuntimeException('Source asset not found', 404);
    }

    ensureDirectory($targetDir);

    $ext = pathinfo($sourcePath, PATHINFO_EXTENSION) ?: 'bin';
    $filename = 'favorite_' . date('Ymd_His') . '_' . bin2hex(random_bytes(3)) . '.' . $ext;
    $destination = rtrim($targetDir, " /\\") . '/' . $filename;

    if (!@copy($sourcePath, $destination)) {
        throw new RuntimeException('Failed to copy favorite asset', 500);
    }

    return makeRelativePath($destination, $baseDir);
}

function makeRelativePath(string $path, string $baseDir): string
{
    $base = rtrim(str_replace('\\', '/', $baseDir), '/') . '/';
    $normalized = str_replace('\\', '/', $path);
    if (strpos($normalized, $base) === 0) {
        $relative = substr($normalized, strlen($base));
    } else {
        $relative = $path;
    }
    return ltrim(str_replace('\\', '/', $relative), '/');
}

function findFavoriteById(string $favoritesLog, string $identifier): ?array
{
    if (!is_file($favoritesLog)) {
        return null;
    }
    $lines = @file($favoritesLog, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    foreach ($lines as $line) {
        $decoded = json_decode($line, true);
        if (is_array($decoded) && ($decoded['id'] ?? '') === $identifier) {
            return $decoded;
        }
    }
    return null;
}
