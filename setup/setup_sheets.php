<?php
/**
 * One-time initialiser. Visit:
 *   /setup/setup_sheets.php?key=YOUR_SETUP_KEY
 *
 * When Google Sheets is configured it creates one tab per entity and seeds it
 * from the repo's data/*.json files. With no Sheets configured it simply
 * verifies the JSON-file store is present (which already works out of the box).
 * Delete or block this file after running, and set SETUP_DONE in production.
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

$source = new JsonFileStore();

if (!tbi_use_sheets()) {
    echo "No Google Sheets configured — using the JSON-file store.\n";
    foreach (array_keys(TBI_ENTITIES) as $entity) {
        $n = count($source->getAll($entity));
        echo str_pad($entity, 16) . ": $n records (data/$entity.json)\n";
    }
    echo "\nReady. The app will read/write data/*.json on this server.\n";
    exit;
}

echo "Seeding Google Sheets (spreadsheet " . SPREADSHEET_ID . ")...\n\n";
$svc   = new GoogleSheetsService(tbi_credentials_path(), SPREADSHEET_ID);
$store = new GoogleSheetsStore();

foreach (array_keys(TBI_ENTITIES) as $entity) {
    $svc->ensureSheet(tbi_sheet_name($entity));
    $rows = $source->getAll($entity);
    $store->replace($entity, $rows);
    echo str_pad($entity, 16) . ": seeded " . count($rows) . " records\n";
}

echo "\nDone. Block this file and set SETUP_DONE=1 now.\n";
