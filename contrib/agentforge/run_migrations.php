<?php

/**
 * AgentForge bootstrap migration runner.
 *
 * Avoids Doctrine\Migrations because:
 *   - the upstream openemr/openemr:flex image's frozen vendor/ doesn't
 *     ship doctrine/migrations, and `composer install` would upgrade
 *     ~16 unrelated upstream packages (swagger-php 3 → 6, etc.).
 *   - bin/console + ./cli call Symfony\Console\Application::addCommand(),
 *     which only exists in symfony/console 7.4+; the image has 7.3.
 *
 * Tracks applied versions in an extension-owned history table —
 * agentforge_schema_migrations — separate from doctrine's `migrations`
 * table so a future Doctrine integration is unaffected.
 *
 * Idempotent: re-running is a no-op once all versions are applied. Each
 * step's precondition uses information_schema / categories existence so
 * a new prod runs the consolidated migration; an existing DB sees the
 * objects already present and marks the version applied without touching
 * anything.
 *
 * Drift reconciliation: after the version loop, a column-spec pass
 * (`$expectedColumns`) ALTER-adds any column missing from a managed
 * table. This catches two cases:
 *
 *   1. A CREATE TABLE in this file gained a column *after* a Railway
 *      DB had already marked the migration version applied — without
 *      this pass, the runner would skip on version-applied and the
 *      schema would silently lag the code.
 *
 *   2. AgentForge added a column to a *non*-agentforge table (e.g.
 *      `lists.source_document_id`) and OpenEMR's `auto_configure.php`
 *      later recreated that table from the upstream `sql/database.sql`
 *      base schema (typical on a cold-init container without a sites
 *      volume). The base schema does not know about our additions, so
 *      the column is dropped while the migration version remains
 *      applied. Without this pass we'd silently lose the column on
 *      every cold reset and intake commits would fail with
 *      "Unknown column 'source_document_id'".
 *
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GPL-3
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "must be run from CLI\n");
    exit(1);
}

$host = (string) (getenv('MYSQL_HOST') ?: '');
$port = (int) (getenv('MYSQL_PORT') ?: 3306);
$db = (string) (getenv('MYSQL_DATABASE') ?: '');
$user = (string) (getenv('MYSQL_ROOT_USER') ?: getenv('MYSQL_USER') ?: '');
$pass = (string) (getenv('MYSQL_ROOT_PASS') ?: getenv('MYSQL_PASS') ?: '');

if ($host === '' || $db === '' || $user === '') {
    fwrite(STDERR, "MYSQL_* env vars not set\n");
    exit(1);
}

mysqli_report(MYSQLI_REPORT_OFF);
$conn = mysqli_connect($host, $user, $pass, $db, $port);
if (!$conn) {
    fwrite(STDERR, "DB connect failed: " . mysqli_connect_error() . PHP_EOL);
    exit(2);
}

function q(mysqli $c, string $sql, ?string $note = null): void
{
    if (!mysqli_query($c, $sql)) {
        $msg = mysqli_error($c);
        $tag = $note ?? substr($sql, 0, 60);
        fwrite(STDERR, "  ERR [$tag]: $msg\n");
        throw new RuntimeException($msg);
    }
}

function applied(mysqli $c, string $version): bool
{
    $stmt = mysqli_prepare($c, "SELECT 1 FROM agentforge_schema_migrations WHERE version = ?");
    mysqli_stmt_bind_param($stmt, 's', $version);
    mysqli_stmt_execute($stmt);
    mysqli_stmt_store_result($stmt);
    $found = mysqli_stmt_num_rows($stmt) > 0;
    mysqli_stmt_close($stmt);
    return $found;
}

function mark(mysqli $c, string $version): void
{
    $stmt = mysqli_prepare(
        $c,
        "INSERT INTO agentforge_schema_migrations (version, applied_at) VALUES (?, UTC_TIMESTAMP())"
    );
    mysqli_stmt_bind_param($stmt, 's', $version);
    mysqli_stmt_execute($stmt);
    mysqli_stmt_close($stmt);
}

// ---- history table (idempotent) ----
q(
    $conn,
    "CREATE TABLE IF NOT EXISTS agentforge_schema_migrations (
        version VARCHAR(64) NOT NULL PRIMARY KEY,
        applied_at DATETIME NOT NULL
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
);

// ---- migrations ----
//
// One consolidated migration that creates the entire AgentForge schema
// in its W2 final state. Replaces the per-step trail
// (20260505120001..120004, 20260506120001, 20260506130001..130003,
// 20260507120001) that was used during W2 development. Its precondition
// is "any of the consolidated objects is missing" so an existing DB
// where the older migrations already ran sees the objects present and
// marks the consolidated version applied without doing anything.
$migrations = [
    '20260507150000' => [
        'desc' => 'AgentForge consolidated schema (extractions + upload_jobs + resource_links + source_document_id)',
        'precondition' => function (mysqli $c): bool {
            // Run when any of the four consolidated objects is missing.
            return !tableExists($c, 'agentforge_document_extractions')
                || !tableExists($c, 'agentforge_upload_jobs')
                || !tableExists($c, 'agentforge_resource_links')
                || !columnExists($c, 'lists', 'source_document_id')
                || !columnExists($c, 'pnotes', 'source_document_id');
        },
        'apply' => function (mysqli $c): void {
            // ── agentforge_document_extractions ──────────────────────────
            //
            // VLM-extracted JSON, review state, and the clinician's
            // confirm/reject provenance. `error_message` is LONGTEXT so
            // we can dump full stack traces for failed extractions.
            if (!tableExists($c, 'agentforge_document_extractions')) {
                q($c, "CREATE TABLE agentforge_document_extractions (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    document_id BIGINT UNSIGNED NOT NULL,
                    patient_id BIGINT UNSIGNED NOT NULL,
                    doc_type VARCHAR(32) NOT NULL,
                    schema_version VARCHAR(16) NOT NULL,
                    extracted_json MEDIUMTEXT NOT NULL,
                    patient_match_status VARCHAR(32) NOT NULL DEFAULT 'unverifiable',
                    injection_suspected TINYINT(1) NOT NULL DEFAULT 0,
                    extraction_status VARCHAR(32) NOT NULL DEFAULT 'pending',
                    reviewed_by_user_id BIGINT UNSIGNED NULL,
                    reviewed_at DATETIME NULL,
                    review_decision VARCHAR(16) NULL,
                    edited_field_paths JSON NULL,
                    error_message LONGTEXT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    INDEX idx_extractions_document_id (document_id),
                    INDEX idx_extractions_patient_doctype_recent (patient_id, doc_type, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            }

            // ── agentforge_upload_jobs ───────────────────────────────────
            //
            // The Document Inbox row. `job_uuid` is the public identifier
            // surfaced in URLs and HTTP polling; status is the
            // UploadJobStatus state machine; started_at/finished_at drive
            // the inbox sort and the stepper duration display.
            if (!tableExists($c, 'agentforge_upload_jobs')) {
                q($c, "CREATE TABLE agentforge_upload_jobs (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    job_uuid VARCHAR(36) NOT NULL,
                    document_id BIGINT UNSIGNED NULL,
                    patient_id BIGINT UNSIGNED NOT NULL,
                    doc_type VARCHAR(32) NOT NULL,
                    status VARCHAR(32) NOT NULL DEFAULT 'pending',
                    error_code VARCHAR(64) NULL,
                    error_message LONGTEXT NULL,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL,
                    started_at DATETIME NULL,
                    finished_at DATETIME NULL,
                    PRIMARY KEY (id),
                    UNIQUE INDEX uq_jobs_job_uuid (job_uuid),
                    INDEX idx_jobs_document_id (document_id),
                    INDEX idx_jobs_patient_status (patient_id, status, created_at),
                    INDEX idx_jobs_started_at (started_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            }

            // ── agentforge_resource_links ────────────────────────────────
            //
            // Back-pointer table linking extractions to the downstream
            // OpenEMR rows they wrote through to. `resource_type` is the
            // destination MySQL table name; `resource_id` is the integer
            // PK in that table (string-typed because some destinations
            // use UUIDs).
            if (!tableExists($c, 'agentforge_resource_links')) {
                q($c, "CREATE TABLE agentforge_resource_links (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    extraction_id BIGINT UNSIGNED NOT NULL,
                    resource_type VARCHAR(64) NOT NULL,
                    resource_id VARCHAR(128) NOT NULL,
                    created_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    INDEX idx_links_extraction (extraction_id),
                    INDEX idx_links_resource (resource_type, resource_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            }

            // ── lists.source_document_id / pnotes.source_document_id ─────
            //
            // AgentForge attribution columns. NULL on every row not
            // written by an AgentForge confirm — readers that see NULL
            // treat the row as a regular chart entry. Indexed so the
            // chat-time origin lookup stays cheap on patients with many
            // list rows.
            if (!columnExists($c, 'lists', 'source_document_id')) {
                q($c, "ALTER TABLE lists
                           ADD COLUMN source_document_id BIGINT UNSIGNED NULL,
                           ADD INDEX idx_lists_source_document (source_document_id)");
            }
            if (!columnExists($c, 'pnotes', 'source_document_id')) {
                q($c, "ALTER TABLE pnotes
                           ADD COLUMN source_document_id BIGINT UNSIGNED NULL,
                           ADD INDEX idx_pnotes_source_document (source_document_id)");
            }
        },
    ],

    // Idempotent chart-write support. Adds:
    //
    //  1. `agentforge_chart_evidence` — append-only join table tying
    //     each commit to the chart row it asserted, keyed on the
    //     entity's natural dedup key. The lab + intake writers consult
    //     this table on every confirm to decide INSERT vs UPDATE.
    //     Multiple evidence rows can share a (patient, table, dedup_key)
    //     tuple; they all point at the same chart_row_id. The "what
    //     extractions assert this row?" query reads them all; the
    //     "do we have an existing row?" query takes ORDER BY id DESC
    //     LIMIT 1.
    //
    //  2. `agentforge_upload_jobs.file_hash_sha256` — SHA-256 of the
    //     uploaded file bytes, used by the upload-time soft duplicate
    //     warning. Hash collisions on a 64-char hex string are
    //     irrelevant in practice; index it so the per-patient lookup at
    //     upload time stays cheap.
    '20260510120000' => [
        'desc' => 'Chart-write idempotency: agentforge_chart_evidence + agentforge_upload_jobs.file_hash_sha256',
        'precondition' => function (mysqli $c): bool {
            return !tableExists($c, 'agentforge_chart_evidence')
                || !columnExists($c, 'agentforge_upload_jobs', 'file_hash_sha256');
        },
        'apply' => function (mysqli $c): void {
            if (!tableExists($c, 'agentforge_chart_evidence')) {
                q($c, "CREATE TABLE agentforge_chart_evidence (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    patient_id BIGINT UNSIGNED NOT NULL,
                    chart_table VARCHAR(64) NOT NULL,
                    chart_row_id BIGINT UNSIGNED NOT NULL,
                    dedup_key VARCHAR(255) NOT NULL,
                    extraction_id BIGINT UNSIGNED NOT NULL,
                    document_id BIGINT UNSIGNED NULL,
                    committed_at DATETIME NOT NULL,
                    PRIMARY KEY (id),
                    INDEX idx_evidence_dedup (patient_id, chart_table, dedup_key),
                    INDEX idx_evidence_extraction (extraction_id),
                    INDEX idx_evidence_chart_row (chart_table, chart_row_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
            }
            if (!columnExists($c, 'agentforge_upload_jobs', 'file_hash_sha256')) {
                q($c, "ALTER TABLE agentforge_upload_jobs
                           ADD COLUMN file_hash_sha256 CHAR(64) NULL AFTER doc_type,
                           ADD INDEX idx_jobs_patient_hash (patient_id, file_hash_sha256)");
            }
        },
    ],
];

function tableExists(mysqli $c, string $name): bool
{
    // SHOW TABLES doesn't accept placeholder bindings on every MySQL build,
    // so use information_schema (which does) instead.
    $stmt = mysqli_prepare(
        $c,
        "SELECT 1 FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1"
    );
    mysqli_stmt_bind_param($stmt, 's', $name);
    mysqli_stmt_execute($stmt);
    mysqli_stmt_store_result($stmt);
    $found = mysqli_stmt_num_rows($stmt) > 0;
    mysqli_stmt_close($stmt);
    return $found;
}

function columnExists(mysqli $c, string $table, string $column): bool
{
    $stmt = mysqli_prepare(
        $c,
        "SELECT 1 FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1"
    );
    mysqli_stmt_bind_param($stmt, 'ss', $table, $column);
    mysqli_stmt_execute($stmt);
    mysqli_stmt_store_result($stmt);
    $found = mysqli_stmt_num_rows($stmt) > 0;
    mysqli_stmt_close($stmt);
    return $found;
}

// ---- expected column spec for drift reconciliation ----
//
// Source of truth for columns that have been added to a managed
// agentforge_* table at any point. Each entry is the column name → the
// fragment used after `ADD COLUMN <name>` in an ALTER. Order in the
// inner array matters only for AFTER clauses (so the ALTER falls in
// the same physical position as the CREATE TABLE above).
//
// MUST mirror the CREATE TABLE blocks in $migrations: when you add a
// column to a CREATE TABLE, add it here too so existing Railway/prod
// DBs (whose migration version is already marked applied) get the new
// column via the reconciliation pass below.
//
// Only list columns; index-only changes still go in a new migration
// version so the apply log records them.
$expectedColumns = [
    'agentforge_document_extractions' => [
        'reviewed_by_user_id' => 'BIGINT UNSIGNED NULL AFTER extraction_status',
        'reviewed_at' => 'DATETIME NULL AFTER reviewed_by_user_id',
        'review_decision' => 'VARCHAR(16) NULL AFTER reviewed_at',
        'edited_field_paths' => 'JSON NULL AFTER review_decision',
    ],
    'agentforge_upload_jobs' => [
        'error_code' => 'VARCHAR(64) NULL AFTER status',
        // Existing rows need a default — the CREATE TABLE in $migrations
        // declares NOT NULL with no default, but reconciliation runs
        // against tables that already have rows, so a CURRENT_TIMESTAMP
        // default is required for the ALTER to succeed without a backfill.
        'created_at' => 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER error_message',
        'updated_at' => 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at',
        // Soft duplicate detection at upload time. NULL on legacy rows;
        // populated on every new upload from the file bytes.
        'file_hash_sha256' => 'CHAR(64) NULL AFTER doc_type',
    ],

    // Cross-table AgentForge attribution columns. These live on upstream
    // OpenEMR tables, so OpenEMR's auto_configure.php can drop them when
    // it recreates the base schema on a cold-init container — see the
    // file-level docblock for the full failure mode. The DDL embeds an
    // `ADD INDEX` after the column so a single ALTER restores both
    // (matches the consolidated migration's CREATE-time DDL).
    'lists' => [
        'source_document_id' => 'BIGINT UNSIGNED NULL, ADD INDEX idx_lists_source_document (source_document_id)',
    ],
    'pnotes' => [
        'source_document_id' => 'BIGINT UNSIGNED NULL, ADD INDEX idx_pnotes_source_document (source_document_id)',
    ],
];

function reconcileColumns(mysqli $c, array $spec): int
{
    $added = 0;
    foreach ($spec as $table => $cols) {
        if (!tableExists($c, $table)) {
            // Table absent entirely → either a fresh DB before the
            // migration loop ran (we're called after, so this is rare)
            // or the table was renamed. Either way, ALTER would fail —
            // skip and let the migration loop or the operator handle it.
            continue;
        }
        foreach ($cols as $col => $ddl) {
            if (columnExists($c, $table, $col)) {
                continue;
            }
            echo "  [drift] $table.$col missing — ALTER ADD\n";
            // Identifier-quote table/column to keep this readable; the
            // strings are file-local literals, not user input.
            q($c, "ALTER TABLE `$table` ADD COLUMN `$col` $ddl");
            $added++;
        }
    }
    return $added;
}

// ---- run ----
echo "AgentForge migrations runner\n";
$applied = 0;
$skipped = 0;
foreach ($migrations as $version => $m) {
    $version = (string) $version; // PHP coerces all-digit array keys to int
    if (applied($conn, $version)) {
        echo "  [$version] already applied — skip\n";
        $skipped++;
        continue;
    }
    if (isset($m['precondition']) && !$m['precondition']($conn)) {
        // Resource already exists from a manual patch or prior migration;
        // mark applied without doing anything.
        mark($conn, $version);
        echo "  [$version] precondition false (already exists) — marking applied\n";
        $skipped++;
        continue;
    }
    echo "  [$version] applying: " . $m['desc'] . "\n";
    mysqli_begin_transaction($conn);
    try {
        $m['apply']($conn);
        mark($conn, $version);
        mysqli_commit($conn);
        $applied++;
    } catch (Throwable $e) {
        mysqli_rollback($conn);
        fwrite(STDERR, "FAIL [$version]: " . $e->getMessage() . "\n");
        exit(3);
    }
}

$reconciled = reconcileColumns($conn, $expectedColumns);
echo "done. applied=$applied skipped=$skipped reconciled_columns=$reconciled\n";
