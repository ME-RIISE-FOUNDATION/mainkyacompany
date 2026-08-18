<?php
require_once __DIR__ . '/../config/config.php';
require_once __DIR__ . '/schema.php';

/**
 * Shared PDO connection to the configured MySQL database. Cached for the
 * lifetime of the request so every Store call reuses one connection.
 */
function tbi_pdo(): PDO {
    static $pdo = null;
    if ($pdo instanceof PDO) return $pdo;

    $cfg = tbi_db_config();
    if ($cfg === []) {
        throw new RuntimeException('No MySQL configuration available');
    }
    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $cfg['host'], (int)$cfg['port'], $cfg['name'], $cfg['charset']
    );
    $pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES   => false,
    ]);
    return $pdo;
}

/**
 * MySQL-backed store. One table per entity. Every canonical column from
 * TBI_ENTITIES becomes a real column; any other field a record carries is
 * preserved verbatim in an `extra_json` catch-all column, so the driver is a
 * loss-free drop-in replacement for the schemaless JSON-file store.
 *
 * Tables are created by setup/migrate_to_mysql.php. The mutation semantics
 * (idempotent append on the id column, partial-merge update, full-table
 * replace) intentionally match JsonFileStore so swapping drivers changes
 * nothing the front-end can observe.
 */
class MySqlStore implements Store {
    private PDO $pdo;

    public function __construct() {
        $this->pdo = tbi_pdo();
    }

    /** Backtick-quote an identifier; entity/column names come from our own constants. */
    private function q(string $ident): string {
        return '`' . str_replace('`', '', $ident) . '`';
    }

    public function getAll(string $entity): array {
        $rows = $this->pdo->query('SELECT * FROM ' . $this->q($entity))->fetchAll();
        $out = [];
        foreach ($rows as $row) {
            $extra = $row['extra_json'] ?? null;
            unset($row['extra_json']);
            foreach ($row as $k => $v) {
                if ($v === null) $row[$k] = '';   // mirror the string-centric JSON store
            }
            if (is_string($extra) && $extra !== '') {
                $decoded = json_decode($extra, true);
                if (is_array($decoded)) $row = array_merge($row, $decoded);
            }
            $out[] = $row;
        }
        return $out;
    }

    /** Split a record into known canonical columns and leftover "extra" fields. */
    private function split(string $entity, array $record): array {
        $cols  = TBI_ENTITIES[$entity];
        $known = [];
        $extra = [];
        foreach ($record as $k => $v) {
            if (in_array($k, $cols, true)) {
                $known[$k] = is_null($v) ? '' : (string)$v;
            } else {
                $extra[$k] = $v;
            }
        }
        return [$known, $extra];
    }

    private function insertRow(string $entity, array $record, bool $ignore): void {
        [$known, $extra] = $this->split($entity, $record);
        $names  = array_keys($known);
        $params = [];
        foreach ($known as $k => $v) $params[':' . $k] = $v;

        $names[] = 'extra_json';
        $params[':extra_json'] = $extra ? json_encode($extra, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) : null;

        $colList = implode(', ', array_map(fn($c) => $this->q($c), $names));
        $phList  = implode(', ', array_map(fn($c) => ':' . $c, $names));
        $kw  = $ignore ? 'IGNORE ' : '';
        $sql = "INSERT {$kw}INTO " . $this->q($entity) . " ($colList) VALUES ($phList)";
        $this->pdo->prepare($sql)->execute($params);
    }

    public function replace(string $entity, array $rows): void {
        $this->pdo->beginTransaction();
        try {
            $this->pdo->exec('DELETE FROM ' . $this->q($entity));
            foreach ($rows as $r) $this->insertRow($entity, (array)$r, false);
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    public function append(string $entity, array $record): void {
        // INSERT IGNORE makes a replayed append idempotent on the primary key,
        // matching the JSON store's id-dedupe behaviour.
        $this->insertRow($entity, $record, true);
    }

    public function update(string $entity, string $idField, string $idVal, array $upd): void {
        $cols = TBI_ENTITIES[$entity];
        if (!in_array($idField, $cols, true)) return;   // unknown id column — no-op

        [$known, $extra] = $this->split($entity, $upd);

        $sets   = [];
        $params = [':idval' => (string)$idVal];
        foreach ($known as $k => $v) {
            if ($k === $idField) continue;              // never rewrite the key
            $sets[] = $this->q($k) . ' = :set_' . $k;
            $params[':set_' . $k] = $v;
        }

        // Merge any extra (non-canonical) fields into the existing extra_json blob.
        if ($extra) {
            $cur = $this->pdo->prepare(
                'SELECT extra_json FROM ' . $this->q($entity) . ' WHERE ' . $this->q($idField) . ' = :idval'
            );
            $cur->execute([':idval' => (string)$idVal]);
            $existing = $cur->fetchColumn();
            $merged = is_string($existing) && $existing !== '' ? (json_decode($existing, true) ?: []) : [];
            $merged = array_merge($merged, $extra);
            $sets[] = 'extra_json = :extra_json';
            $params[':extra_json'] = json_encode($merged, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        }

        if (!$sets) return;
        $sql = 'UPDATE ' . $this->q($entity) . ' SET ' . implode(', ', $sets)
             . ' WHERE ' . $this->q($idField) . ' = :idval';
        $this->pdo->prepare($sql)->execute($params);
    }

    public function delete(string $entity, string $idField, string $idVal): void {
        $cols = TBI_ENTITIES[$entity];
        if (!in_array($idField, $cols, true)) return;   // unknown id column — no-op
        $sql = 'DELETE FROM ' . $this->q($entity) . ' WHERE ' . $this->q($idField) . ' = :idval';
        $this->pdo->prepare($sql)->execute([':idval' => (string)$idVal]);
    }
}
