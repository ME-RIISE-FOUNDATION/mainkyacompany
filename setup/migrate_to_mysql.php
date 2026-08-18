<?php
/**
 * One-time MySQL initialiser. Visit once in a browser:
 *   /setup/migrate_to_mysql.php?key=YOUR_SETUP_KEY
 *
 * It (1) creates one table per entity — every canonical column plus an
 * `extra_json` catch-all — and (2) imports the existing data/*.json records.
 * Safe to re-run: tables use CREATE TABLE IF NOT EXISTS and rows are inserted
 * with INSERT IGNORE, so existing data is never duplicated or clobbered.
 *
 * Requires config/database.php (or DB_* env vars) to be set first.
 * Delete or block this file after running.
 */

require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/../api/schema.php';
require_once __DIR__ . '/../api/Store.php';

header('Content-Type: text/plain');

if (getenv('SETUP_DONE')) {
    http_response_code(403);
    exit("Setup already completed (SETUP_DONE is set). Remove it to re-run.\n");
}
if (($_GET['key'] ?? '') !== SETUP_KEY) {
    http_response_code(403);
    exit("Forbidden: invalid or missing ?key=\n");
}
if (!tbi_use_mysql()) {
    http_response_code(400);
    exit("No MySQL configured. Copy config/database.sample.php to config/database.php and fill it in first.\n");
}

try {
    $pdo = tbi_pdo();
} catch (Throwable $e) {
    http_response_code(500);
    exit('Could not connect to MySQL: ' . $e->getMessage() . "\n");
}

echo "Connected to MySQL.\n\n";

$source = new JsonFileStore();
$store  = new MySqlStore();

foreach (TBI_ENTITIES as $entity => $cols) {
    $pk = $cols[0];

    // Build: PK first (indexable VARCHAR), remaining canonical cols as TEXT,
    // plus an extra_json catch-all. utf8mb4 throughout for full Unicode.
    $defs = ['`' . $pk . '` VARCHAR(191) NOT NULL'];
    foreach (array_slice($cols, 1) as $c) {
        $defs[] = '`' . $c . '` TEXT NULL';
    }
    $defs[] = '`extra_json` LONGTEXT NULL';
    $defs[] = 'PRIMARY KEY (`' . $pk . '`)';

    $sql = 'CREATE TABLE IF NOT EXISTS `' . $entity . '` (' . implode(', ', $defs)
         . ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
    $pdo->exec($sql);

    // Seed from the JSON file. append() is INSERT IGNORE, so rows already in
    // the table are left untouched.
    $rows = $source->getAll($entity);
    $before = (int)$pdo->query('SELECT COUNT(*) FROM `' . $entity . '`')->fetchColumn();
    foreach ($rows as $r) {
        $store->append($entity, $r);
    }
    $after = (int)$pdo->query('SELECT COUNT(*) FROM `' . $entity . '`')->fetchColumn();

    printf("%-16s table ready — imported %d new of %d JSON records (now %d total)\n",
        $entity, $after - $before, count($rows), $after);
}

echo "\nDone. The app is now reading and writing MySQL.\n";
echo "Delete or block setup/migrate_to_mysql.php now (and set SETUP_DONE=1 if you can).\n";
