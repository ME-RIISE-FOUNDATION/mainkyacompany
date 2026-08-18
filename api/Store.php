<?php
require_once __DIR__ . '/schema.php';
require_once __DIR__ . '/GoogleSheetsService.php';
require_once __DIR__ . '/MySqlStore.php';

/**
 * Storage abstraction shared by both drivers. Every method works on whole
 * records keyed by an id field, mirroring the front-end DB layer so the API
 * stays a thin, generic sync store.
 */
interface Store {
    public function getAll(string $entity): array;
    public function replace(string $entity, array $rows): void;
    public function append(string $entity, array $record): void;
    public function update(string $entity, string $idField, string $idVal, array $upd): void;
    public function delete(string $entity, string $idField, string $idVal): void;
}

/**
 * Picks a backend in priority order: MySQL when configured, then Google Sheets,
 * otherwise the zero-config JSON-file driver. Any driver that fails to
 * initialise falls through to the next so the app stays available.
 */
class StoreFactory {
    /** Driver chosen by the last make() call: 'mysql' | 'sheets' | 'json'. */
    public static string $active = 'json';

    public static function make(): Store {
        if (tbi_use_mysql()) {
            try {
                $store = new MySqlStore();
                self::$active = 'mysql';
                return $store;
            } catch (Throwable $e) {
                // Loud, not silent: a broken DB must not hide behind the JSON
                // fallback unnoticed. Surfaced via data_api.php ?action=health.
                error_log('[TBI] MySQL configured but UNAVAILABLE — falling back to JSON store: ' . $e->getMessage());
            }
        }
        if (tbi_use_sheets()) {
            try {
                $store = new GoogleSheetsStore();
                self::$active = 'sheets';
                return $store;
            } catch (Throwable $e) {
                error_log('[TBI] Sheets store unavailable, falling back to JSON: ' . $e->getMessage());
            }
        }
        self::$active = 'json';
        return new JsonFileStore();
    }
}

/**
 * JSON-file backed store. Each entity lives in data/<entity>.json. A per-entity
 * lock file serialises read-modify-write cycles so concurrent requests from
 * different devices do not clobber one another.
 */
class JsonFileStore implements Store {
    private function path(string $entity): string {
        return DATA_DIR . '/' . $entity . '.json';
    }

    public function getAll(string $entity): array {
        $p = $this->path($entity);
        if (!file_exists($p)) return [];
        $data = json_decode(file_get_contents($p), true);
        return is_array($data) ? $data : [];
    }

    private function save(string $entity, array $rows): void {
        file_put_contents(
            $this->path($entity),
            json_encode(array_values($rows), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            LOCK_EX
        );
    }

    /** Run a mutation under an exclusive cross-process lock. */
    private function withLock(string $entity, callable $fn): void {
        $lock = fopen(DATA_DIR . '/.' . $entity . '.lock', 'c');
        if ($lock) flock($lock, LOCK_EX);
        try {
            $fn();
        } finally {
            if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
        }
    }

    public function replace(string $entity, array $rows): void {
        $this->withLock($entity, fn() => $this->save($entity, $rows));
    }

    public function append(string $entity, array $record): void {
        $this->withLock($entity, function () use ($entity, $record) {
            $rows  = $this->getAll($entity);
            $idCol = TBI_ENTITIES[$entity][0];
            // Idempotent: a retried/replayed append must not create a duplicate.
            if (isset($record[$idCol]) && $record[$idCol] !== '') {
                foreach ($rows as $r) {
                    if (isset($r[$idCol]) && (string)$r[$idCol] === (string)$record[$idCol]) return;
                }
            }
            $rows[] = $record;
            $this->save($entity, $rows);
        });
    }

    public function update(string $entity, string $idField, string $idVal, array $upd): void {
        $this->withLock($entity, function () use ($entity, $idField, $idVal, $upd) {
            $rows = $this->getAll($entity);
            foreach ($rows as &$r) {
                if (isset($r[$idField]) && (string)$r[$idField] === (string)$idVal) {
                    $r = array_merge($r, $upd);
                }
            }
            $this->save($entity, $rows);
        });
    }

    public function delete(string $entity, string $idField, string $idVal): void {
        $this->withLock($entity, function () use ($entity, $idField, $idVal) {
            $rows = array_filter(
                $this->getAll($entity),
                fn($r) => !(isset($r[$idField]) && (string)$r[$idField] === (string)$idVal)
            );
            $this->save($entity, $rows);
        });
    }
}

/**
 * Google Sheets backed store. Reads/writes one tab per entity using the first
 * row as the header. Mutations read the tab, apply the change in PHP and write
 * the whole tab back — simple and correct for this low-volume workload.
 */
class GoogleSheetsStore implements Store {
    private GoogleSheetsService $svc;

    public function __construct() {
        $this->svc = new GoogleSheetsService(tbi_credentials_path(), SPREADSHEET_ID);
    }

    public function getAll(string $entity): array {
        $rows = $this->svc->readRange(tbi_sheet_name($entity) . '!A1:Z');
        if (count($rows) < 1) return [];
        $header = $rows[0];
        $out = [];
        for ($i = 1; $i < count($rows); $i++) {
            $rec = [];
            foreach ($header as $c => $col) {
                $rec[$col] = $rows[$i][$c] ?? '';
            }
            $out[] = $rec;
        }
        return $out;
    }

    private function writeAll(string $entity, array $records): void {
        $cols = TBI_ENTITIES[$entity];
        $values = [$cols];
        foreach ($records as $rec) {
            $row = [];
            foreach ($cols as $c) $row[] = (string)($rec[$c] ?? '');
            $values[] = $row;
        }
        $sheet = tbi_sheet_name($entity);
        $this->svc->clearRange($sheet . '!A1:Z');
        $this->svc->writeRange($sheet . '!A1', $values);
    }

    public function replace(string $entity, array $rows): void {
        $this->writeAll($entity, $rows);
    }

    public function append(string $entity, array $record): void {
        $rows  = $this->getAll($entity);
        $idCol = TBI_ENTITIES[$entity][0];
        // Idempotent: a retried/replayed append must not create a duplicate.
        if (isset($record[$idCol]) && $record[$idCol] !== '') {
            foreach ($rows as $r) {
                if (isset($r[$idCol]) && (string)$r[$idCol] === (string)$record[$idCol]) return;
            }
        }
        $rows[] = $record;
        $this->writeAll($entity, $rows);
    }

    public function update(string $entity, string $idField, string $idVal, array $upd): void {
        $rows = $this->getAll($entity);
        foreach ($rows as &$r) {
            if (isset($r[$idField]) && (string)$r[$idField] === (string)$idVal) {
                $r = array_merge($r, $upd);
            }
        }
        $this->writeAll($entity, $rows);
    }

    public function delete(string $entity, string $idField, string $idVal): void {
        $rows = array_filter(
            $this->getAll($entity),
            fn($r) => !(isset($r[$idField]) && (string)$r[$idField] === (string)$idVal)
        );
        $this->writeAll($entity, array_values($rows));
    }
}
