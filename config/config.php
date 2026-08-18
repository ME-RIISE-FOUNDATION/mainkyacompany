<?php
/**
 * Central configuration. All secrets are read from environment variables so
 * nothing sensitive needs to be committed. Works out-of-the-box (JSON-file
 * store) even with no env vars set; add SPREADSHEET_ID + credentials to switch
 * the same code to a shared Google Sheets backend.
 */

define('PROJECT_ROOT', dirname(__DIR__));
define('DATA_DIR', PROJECT_ROOT . '/data');

// Google Sheets spreadsheet id (empty => JSON-file store is used instead)
define('SPREADSHEET_ID', getenv('SPREADSHEET_ID') ?: '');

// Guards the one-time setup endpoint
define('SETUP_KEY', getenv('SETUP_KEY') ?: 'TBI_SETUP_2024');

/**
 * Resolve the Google service-account credentials file.
 * Priority: GOOGLE_CREDENTIALS_BASE64 env var -> config/credentials.json file.
 * Returns '' when no credentials are available.
 */
function tbi_credentials_path(): string {
    $b64 = getenv('GOOGLE_CREDENTIALS_BASE64');
    if ($b64) {
        $tmp = sys_get_temp_dir() . '/tbi_credentials.json';
        if (!file_exists($tmp)) {
            file_put_contents($tmp, base64_decode($b64));
        }
        return $tmp;
    }
    $file = __DIR__ . '/credentials.json';
    return file_exists($file) ? $file : '';
}

/** True when a real Google Sheets backend is configured and reachable. */
function tbi_use_sheets(): bool {
    return SPREADSHEET_ID !== '' && tbi_credentials_path() !== '';
}

/**
 * Resolve MySQL connection settings. Two sources, in priority order:
 *   1. config/database.php  — a PHP file returning an array (recommended on
 *      shared hosting like Hostinger, where setting env vars is awkward).
 *   2. DB_HOST / DB_NAME / DB_USER / DB_PASS / DB_PORT environment variables
 *      (handy for Docker / PaaS).
 * Returns [] when no database is configured, so the app falls back to the
 * JSON-file store and keeps working out of the box.
 */
function tbi_db_config(): array {
    $file = __DIR__ . '/database.php';
    if (is_file($file)) {
        $cfg = require $file;
        if (is_array($cfg) && trim((string)($cfg['host'] ?? '')) !== '' && trim((string)($cfg['name'] ?? '')) !== '') {
            return tbi_clean_db_config($cfg);
        }
    }
    $host = getenv('DB_HOST') ?: '';
    $name = getenv('DB_NAME') ?: '';
    if ($host !== '' && $name !== '') {
        return tbi_clean_db_config([
            'host' => $host,
            'name' => $name,
            'user' => getenv('DB_USER') ?: '',
            'pass' => getenv('DB_PASS') ?: '',
            'port' => getenv('DB_PORT') ?: 3306,
        ]);
    }
    return [];
}

/**
 * Normalise raw connection settings. Hand-edited credential files (e.g. via
 * Hostinger's File Manager) routinely pick up a stray trailing newline or
 * spaces — fatal for MySQL auth — so identifiers are trimmed of all surrounding
 * whitespace. The password is only stripped of CR/LF (never spaces, which could
 * be intentional). Returns the canonical [host,name,user,pass,port,charset] shape.
 */
function tbi_clean_db_config(array $cfg): array {
    return [
        'host'    => trim((string)($cfg['host'] ?? '')),
        'name'    => trim((string)($cfg['name'] ?? '')),
        'user'    => trim((string)($cfg['user'] ?? '')),
        'pass'    => trim((string)($cfg['pass'] ?? ''), "\r\n"),
        'port'    => (int)($cfg['port'] ?? 3306),
        'charset' => trim((string)($cfg['charset'] ?? 'utf8mb4')) ?: 'utf8mb4',
    ];
}

/** True when a MySQL backend is configured. */
function tbi_use_mysql(): bool {
    return tbi_db_config() !== [];
}
