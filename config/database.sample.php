<?php
/**
 * MySQL connection settings for the Hostinger (or any MySQL) backend.
 *
 * SETUP:
 *   1. In Hostinger hPanel → Databases → "MySQL Databases", create a database
 *      and a user, and attach the user to the database.
 *   2. Copy this file to  config/database.php  (same folder).
 *   3. Fill in the four values below from hPanel.
 *   4. Confirm the connection at  /api/data_api.php?action=health  — expect
 *      {"store":"mysql","db_ok":true}. If db_ok is false, the credentials or the
 *      user-to-database attachment are wrong; fix them before continuing.
 *   5. Visit  /setup/migrate_to_mysql.php?key=YOUR_SETUP_KEY  once to create the
 *      tables and import the existing data/*.json records.
 *
 * config/database.php is gitignored — your password is never committed.
 * If this file (or database.php) is absent, the app keeps using the JSON-file
 * store, so nothing breaks before you configure the database.
 */

return [
    // On Hostinger shared hosting the DB host is almost always 'localhost'.
    'host' => 'localhost',

    // The full database name shown in hPanel, e.g. u123456789_tbi
    'name' => 'u123456789_dbname',

    // The MySQL user, e.g. u123456789_tbiuser
    'user' => 'u123456789_dbuser',

    // The password you set for that MySQL user
    'pass' => 'your-db-password',

    // Leave as-is unless your host uses a non-standard port
    'port' => 3306,
];
