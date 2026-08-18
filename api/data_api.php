<?php
/**
 * Generic sync API used by the front-end DB layer.
 *
 *   GET  ?action=bootstrap                 -> { ok, data:{ entity: [...] , ... } }
 *   POST { action:'append',  entity, record }
 *   POST { action:'update',  entity, idField, idVal, upd }
 *   POST { action:'delete',  entity, idField, idVal }
 *   POST { action:'replace', entity, data:[...] }
 *   POST { action:'login',   username, password } -> { ok, user } (no password field)
 *   POST { action:'set_password', username, newPassword, currentPassword? }
 *
 * POST bodies are JSON. Writes are intentionally fire-and-forget friendly:
 * the front-end sends them with fetch keepalive and does not await a response.
 *
 * Credentials never leave the server in cleartext: passwords are stored only as
 * bcrypt hashes (Password_Hash) and stripped from every bootstrap response.
 */

require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/schema.php';
require_once __DIR__ . '/Store.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg]);
    exit;
}

/** Remove credential fields from a user record before it leaves the server. */
function tbi_strip_credentials(array $user): array {
    unset($user['Password'], $user['Password_Hash']);
    return $user;
}

/**
 * Normalise a user write so a cleartext Password is never stored: any incoming
 * Password is hashed into Password_Hash and dropped. Applied to every users
 * append/update/replace as defence-in-depth.
 */
function tbi_hash_user_write(array $rec): array {
    if (isset($rec['Password']) && $rec['Password'] !== '') {
        $rec['Password_Hash'] = password_hash((string)$rec['Password'], PASSWORD_BCRYPT);
    }
    unset($rec['Password']);
    return $rec;
}

try {
    $store = StoreFactory::make();

    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $action = $_GET['action'] ?? 'bootstrap';

        // Health probe — reports which backend is actually live so a silent MySQL
        // fallback to the JSON store can't hide. store: mysql|sheets|json.
        if ($action === 'health') {
            // $store was already resolved by StoreFactory::make() above, which
            // set StoreFactory::$active to the driver actually in use.
            $dbOk = false;
            if (StoreFactory::$active === 'mysql') {
                // A successful getAll proves the connection AND that tables exist.
                try { $store->getAll('users'); $dbOk = true; }
                catch (Throwable $e) { error_log('[TBI] health: MySQL query failed: ' . $e->getMessage()); }
            }
            echo json_encode([
                'ok'            => true,
                'store'         => StoreFactory::$active,
                'db_ok'         => $dbOk,
                'data_writable' => is_writable(DATA_DIR),
            ]);
            exit;
        }

        if ($action !== 'bootstrap') fail(400, 'Unknown GET action');

        $data = [];
        foreach (array_keys(TBI_ENTITIES) as $entity) {
            $rows = $store->getAll($entity);
            if ($entity === 'users') $rows = array_map('tbi_strip_credentials', $rows);
            $data[$entity] = $rows;
        }
        echo json_encode(['ok' => true, 'data' => $data]);
        exit;
    }

    // POST — JSON body
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'Invalid JSON body');

    $action = $body['action'] ?? '';

    // ── Auth actions (no entity) ──────────────────────────────────
    if ($action === 'login') {
        $username = (string)($body['username'] ?? '');
        $password = (string)($body['password'] ?? '');
        if ($username === '' || $password === '') fail(400, 'Missing credentials');
        foreach ($store->getAll('users') as $u) {
            if (isset($u['Username']) && (string)$u['Username'] === $username) {
                $hash = (string)($u['Password_Hash'] ?? '');
                if ($hash !== '' && password_verify($password, $hash)) {
                    echo json_encode(['ok' => true, 'user' => tbi_strip_credentials($u)]);
                    exit;
                }
                break;
            }
        }
        echo json_encode(['ok' => false, 'error' => 'Invalid username or password']);
        exit;
    }

    if ($action === 'set_password') {
        $username = (string)($body['username'] ?? '');
        $newPwd   = (string)($body['newPassword'] ?? '');
        if ($username === '' || strlen($newPwd) < 8) fail(400, 'Username and an 8+ char new password are required');
        $target = null;
        foreach ($store->getAll('users') as $u) {
            if (isset($u['Username']) && (string)$u['Username'] === $username) { $target = $u; break; }
        }
        if (!$target) fail(404, 'User not found');
        // Self-service path must prove the current password; admin reset omits it.
        if (isset($body['currentPassword'])) {
            $hash = (string)($target['Password_Hash'] ?? '');
            if ($hash === '' || !password_verify((string)$body['currentPassword'], $hash)) {
                echo json_encode(['ok' => false, 'error' => 'Current password is incorrect']);
                exit;
            }
        }
        $store->update('users', 'User_ID', (string)$target['User_ID'],
            ['Password_Hash' => password_hash($newPwd, PASSWORD_BCRYPT)]);
        echo json_encode(['ok' => true]);
        exit;
    }

    $entity = $body['entity'] ?? '';
    tbi_require_entity($entity);

    switch ($action) {
        case 'append':
            if (!isset($body['record']) || !is_array($body['record'])) fail(400, 'Missing record');
            $record = $entity === 'users' ? tbi_hash_user_write($body['record']) : $body['record'];
            $store->append($entity, $record);
            break;

        case 'update':
            foreach (['idField', 'idVal', 'upd'] as $k) {
                if (!isset($body[$k])) fail(400, "Missing $k");
            }
            $upd = $entity === 'users' ? tbi_hash_user_write((array)$body['upd']) : (array)$body['upd'];
            $store->update($entity, (string)$body['idField'], (string)$body['idVal'], $upd);
            break;

        case 'delete':
            foreach (['idField', 'idVal'] as $k) {
                if (!isset($body[$k])) fail(400, "Missing $k");
            }
            $store->delete($entity, (string)$body['idField'], (string)$body['idVal']);
            break;

        case 'replace':
            if (!isset($body['data']) || !is_array($body['data'])) fail(400, 'Missing data');
            $data = $body['data'];
            if ($entity === 'users') $data = array_map('tbi_hash_user_write', $data);
            $store->replace($entity, $data);
            break;

        default:
            fail(400, "Unknown action: $action");
    }

    echo json_encode(['ok' => true]);
} catch (Throwable $e) {
    error_log('[TBI] data_api error: ' . $e->getMessage());
    fail(500, 'Server error');
}
