<?php
/**
 * File-upload endpoint for task attachments (proof of completion / deliverables).
 * Accepts a single multipart file under field name "file" and saves it to
 * /uploads with a generated, collision-proof name. Returns JSON:
 *   { ok:true, url:"uploads/<name>", name:"<original filename>" }
 *
 * The URL is stored as an app-root-relative path in a task's File_URL; the
 * front end resolves it to a full link via Utils.fileUrl(). Only a safe set of
 * document/image extensions is accepted, and the stored name never derives
 * from user input beyond a sanitised slug, so no PHP/executable can be dropped.
 */

header('Content-Type: application/json');

function upload_fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    upload_fail(405, 'Method not allowed');
}

if (!isset($_FILES['file'])) {
    upload_fail(400, 'No file received');
}

$f = $_FILES['file'];

if (!empty($f['error']) && $f['error'] !== UPLOAD_ERR_OK) {
    $map = [
        UPLOAD_ERR_INI_SIZE  => 'File exceeds the server upload limit',
        UPLOAD_ERR_FORM_SIZE => 'File is too large',
        UPLOAD_ERR_PARTIAL   => 'Upload was interrupted, please retry',
        UPLOAD_ERR_NO_FILE   => 'No file received',
        UPLOAD_ERR_NO_TMP_DIR => 'Server temp directory missing',
        UPLOAD_ERR_CANT_WRITE => 'Server could not write the file',
    ];
    upload_fail(400, $map[$f['error']] ?? 'Upload failed');
}

// 10 MB application cap (independent of php.ini, which may allow more/less).
$MAX_BYTES = 10 * 1024 * 1024;
if (($f['size'] ?? 0) <= 0)          upload_fail(400, 'Empty file');
if ($f['size'] > $MAX_BYTES)         upload_fail(400, 'File is larger than 10 MB');
if (!is_uploaded_file($f['tmp_name'])) upload_fail(400, 'Invalid upload');

// Extension allow-list. Anything not here (php, phtml, exe, sh, …) is refused.
$ALLOWED = [
    'jpg','jpeg','png','gif','webp','bmp','heic',
    'pdf','doc','docx','xls','xlsx','ppt','pptx',
    'txt','csv','rtf','odt','ods','zip',
    'mp4','mov','webm','m4v',
];

$orig = (string)($f['name'] ?? 'file');
$ext  = strtolower(pathinfo($orig, PATHINFO_EXTENSION));
if ($ext === '' || !in_array($ext, $ALLOWED, true)) {
    upload_fail(400, 'File type not allowed: .' . $ext);
}

// Build a safe stored name: <date>_<slug>_<random>.<ext>. The slug is derived
// from the original name only for readability and is stripped of anything but
// [a-z0-9-], so the filesystem path is never influenced by user input.
$base = pathinfo($orig, PATHINFO_FILENAME);
$slug = strtolower(preg_replace('/[^A-Za-z0-9]+/', '-', $base));
$slug = trim($slug, '-');
if ($slug === '') $slug = 'file';
$slug = substr($slug, 0, 40);

$uploadsDir = dirname(__DIR__) . '/uploads';
if (!is_dir($uploadsDir) && !mkdir($uploadsDir, 0775, true) && !is_dir($uploadsDir)) {
    upload_fail(500, 'Could not create uploads directory');
}

try {
    $rand = bin2hex(random_bytes(4));
} catch (Throwable $e) {
    $rand = (string)mt_rand(10000000, 99999999);
}
$stored = date('Ymd_His') . '_' . $slug . '_' . $rand . '.' . $ext;
$dest   = $uploadsDir . '/' . $stored;

if (!move_uploaded_file($f['tmp_name'], $dest)) {
    upload_fail(500, 'Could not save the file');
}

echo json_encode([
    'ok'   => true,
    'url'  => 'uploads/' . $stored,
    'name' => $orig,
]);
