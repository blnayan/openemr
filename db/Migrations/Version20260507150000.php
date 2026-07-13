<?php

/**
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Team
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Core\Migrations;

use Doctrine\DBAL\Schema\Schema;
use Doctrine\DBAL\Schema\Table;
use Doctrine\DBAL\Types\Types;
use Doctrine\Migrations\AbstractMigration;

/**
 * AgentForge consolidated schema (W2 final state).
 *
 * Replaces the per-step migration trail (Version20260505120001..120004,
 * Version20260506120001, Version20260507120001) with a single create-it-all
 * migration that matches what the runtime code expects today. Intended for
 * fresh production environments — existing dev DBs that have already
 * applied the older versions can drop the agentforge_* tables and
 * source_document_id columns and re-run.
 *
 * Tables created:
 *   - agentforge_document_extractions : VLM-extracted JSON, review state.
 *   - agentforge_upload_jobs          : SSE/poll surface for the inbox.
 *   - agentforge_resource_links       : back-pointer extraction → resource.
 *
 * Columns added to existing tables:
 *   - lists.source_document_id        : `documents.id` of the source PDF.
 *   - pnotes.source_document_id       : same, for intake-form pnotes.
 *
 * Schema parity: this migration mirrors the consolidated entry
 * '20260507150000' in contrib/agentforge/run_migrations.php. If you change
 * one, change the other.
 */
final class Version20260507150000 extends AbstractMigration
{
    use CreateTableTrait;

    public function getDescription(): string
    {
        return 'AgentForge consolidated schema (extractions + upload_jobs + resource_links + source_document_id)';
    }

    public function up(Schema $schema): void
    {
        // ── agentforge_document_extractions ──────────────────────────────
        $extractions = new Table('agentforge_document_extractions');
        $extractions->addColumn('id', Types::BIGINT, ['unsigned' => true, 'autoincrement' => true]);
        $extractions->addColumn('document_id', Types::BIGINT, ['unsigned' => true]);
        $extractions->addColumn('patient_id', Types::BIGINT, ['unsigned' => true]);
        $extractions->addColumn('doc_type', Types::STRING, ['length' => 32]);
        $extractions->addColumn('schema_version', Types::STRING, ['length' => 16]);
        $extractions->addColumn('extracted_json', Types::TEXT, ['length' => 16777215]); // MEDIUMTEXT
        $extractions->addColumn('patient_match_status', Types::STRING, ['length' => 32, 'default' => 'unverifiable']);
        $extractions->addColumn('injection_suspected', Types::BOOLEAN, ['default' => false]);
        $extractions->addColumn('extraction_status', Types::STRING, ['length' => 32, 'default' => 'pending']);
        // Document Inbox review/confirm provenance (clinician who confirmed,
        // when, terminal action, and which fields they edited away from the
        // VLM's output). All nullable — extraction can complete before the
        // clinician reviews.
        $extractions->addColumn('reviewed_by_user_id', Types::BIGINT, ['unsigned' => true, 'notnull' => false]);
        $extractions->addColumn('reviewed_at', Types::DATETIME_IMMUTABLE, ['notnull' => false]);
        $extractions->addColumn('review_decision', Types::STRING, ['length' => 16, 'notnull' => false]);
        $extractions->addColumn('edited_field_paths', Types::JSON, ['notnull' => false]);
        $extractions->addColumn('error_message', Types::TEXT, ['notnull' => false]);
        $extractions->addColumn('created_at', Types::DATETIME_IMMUTABLE);
        $extractions->addColumn('updated_at', Types::DATETIME_IMMUTABLE);
        $this->addPrimaryKey($extractions, 'id');
        $extractions->addIndex(['document_id'], 'idx_extractions_document_id');
        $extractions->addIndex(['patient_id', 'doc_type', 'created_at'], 'idx_extractions_patient_doctype_recent');
        $this->createTable($extractions);

        // ── agentforge_upload_jobs ───────────────────────────────────────
        $jobs = new Table('agentforge_upload_jobs');
        $jobs->addColumn('id', Types::BIGINT, ['unsigned' => true, 'autoincrement' => true]);
        $jobs->addColumn('job_uuid', Types::STRING, ['length' => 36]);
        $jobs->addColumn('document_id', Types::BIGINT, ['unsigned' => true, 'notnull' => false]);
        $jobs->addColumn('patient_id', Types::BIGINT, ['unsigned' => true]);
        $jobs->addColumn('doc_type', Types::STRING, ['length' => 32]);
        $jobs->addColumn('status', Types::STRING, ['length' => 32, 'default' => 'pending']);
        $jobs->addColumn('error_code', Types::STRING, ['length' => 64, 'notnull' => false]);
        $jobs->addColumn('error_message', Types::TEXT, ['notnull' => false]);
        $jobs->addColumn('created_at', Types::DATETIME_IMMUTABLE);
        $jobs->addColumn('updated_at', Types::DATETIME_IMMUTABLE);
        $jobs->addColumn('started_at', Types::DATETIME_IMMUTABLE, ['notnull' => false]);
        $jobs->addColumn('finished_at', Types::DATETIME_IMMUTABLE, ['notnull' => false]);
        $this->addPrimaryKey($jobs, 'id');
        $jobs->addUniqueIndex(['job_uuid'], 'uq_jobs_job_uuid');
        $jobs->addIndex(['document_id'], 'idx_jobs_document_id');
        $jobs->addIndex(['patient_id', 'status', 'created_at'], 'idx_jobs_patient_status');
        $jobs->addIndex(['started_at'], 'idx_jobs_started_at');
        $this->createTable($jobs);

        // ── agentforge_resource_links ────────────────────────────────────
        $links = new Table('agentforge_resource_links');
        $links->addColumn('id', Types::BIGINT, ['unsigned' => true, 'autoincrement' => true]);
        $links->addColumn('extraction_id', Types::BIGINT, ['unsigned' => true]);
        $links->addColumn('resource_type', Types::STRING, ['length' => 64]);
        $links->addColumn('resource_id', Types::STRING, ['length' => 128]);
        $links->addColumn('created_at', Types::DATETIME_IMMUTABLE);
        $this->addPrimaryKey($links, 'id');
        $links->addIndex(['extraction_id'], 'idx_links_extraction');
        $links->addIndex(['resource_type', 'resource_id'], 'idx_links_resource');
        $this->createTable($links);

        // ── lists.source_document_id / pnotes.source_document_id ─────────
        // Indexed because the chat-time origin lookup arrives as a row UUID,
        // joins to lists.id, and filters by this column. NULL means "regular
        // chart entry, not from an AgentForge upload."
        $lists = $schema->getTable('lists');
        if (!$lists->hasColumn('source_document_id')) {
            $lists->addColumn('source_document_id', 'bigint', ['unsigned' => true, 'notnull' => false]);
            $lists->addIndex(['source_document_id'], 'idx_lists_source_document');
        }
        $pnotes = $schema->getTable('pnotes');
        if (!$pnotes->hasColumn('source_document_id')) {
            $pnotes->addColumn('source_document_id', 'bigint', ['unsigned' => true, 'notnull' => false]);
            $pnotes->addIndex(['source_document_id'], 'idx_pnotes_source_document');
        }
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DROP TABLE IF EXISTS agentforge_resource_links');
        $this->addSql('DROP TABLE IF EXISTS agentforge_upload_jobs');
        $this->addSql('DROP TABLE IF EXISTS agentforge_document_extractions');

        $lists = $schema->getTable('lists');
        if ($lists->hasIndex('idx_lists_source_document')) {
            $lists->dropIndex('idx_lists_source_document');
        }
        if ($lists->hasColumn('source_document_id')) {
            $lists->dropColumn('source_document_id');
        }
        $pnotes = $schema->getTable('pnotes');
        if ($pnotes->hasIndex('idx_pnotes_source_document')) {
            $pnotes->dropIndex('idx_pnotes_source_document');
        }
        if ($pnotes->hasColumn('source_document_id')) {
            $pnotes->dropColumn('source_document_id');
        }
    }
}
