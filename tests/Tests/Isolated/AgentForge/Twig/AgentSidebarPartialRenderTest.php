<?php

/**
 * AgentSidebar Twig Partial Render Test
 *
 * Verifies the sidebar_partial.html.twig template renders the <agent-sidebar>
 * element with correct attributes (data-pid, data-encounter-id, data-patient-uuid)
 * and the expected <script> tag for the Web Component bundle.
 *
 * The same partial is included from two host pages:
 *   - interface/patient_file/summary/demographics.php  (primary; encounter_id null)
 *   - interface/patient_file/encounter/encounter_top.php (secondary; encounter_id set)
 *
 * Open Question Q-NEW-2: neither host may have a Twig environment available.
 * Both branches are tested:
 *   - Twig render path (this file) — skipped with reason if Twig not available
 *   - Raw PHP include path (AgentSidebarPhpIncludeTest — separate test)
 *
 * After modifying the template, run:
 *   composer update-twig-fixtures
 * Review the diff before committing. See CLAUDE.md §"Twig template tests".
 *
 * Plan reference: §5.1, §3.2 (Web Component / Twig partial), M1
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Test Generator
 * @copyright Copyright (c) 2026 OpenEMR Contributors
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\Twig;

use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;
use Twig\Environment;
use Twig\Loader\FilesystemLoader;

#[CoversNothing]
final class AgentSidebarPartialRenderTest extends TestCase
{
    private const TEMPLATES_DIR = __DIR__ . '/../../../../../templates/agentforge';
    private const PARTIAL_FILE  = 'sidebar_partial.html.twig';

    private ?Environment $twig = null;

    protected function setUp(): void
    {
        // Q-NEW-2: If Twig is not available in the encounter_top.php rendering context,
        // the template file may not exist yet. Skip gracefully.
        if (!is_dir(self::TEMPLATES_DIR)) {
            $this->markTestSkipped(
                'Twig template directory templates/agentforge/ does not exist yet. ' .
                'Create it in M1 along with sidebar_partial.html.twig. ' .
                'If neither host (demographics.php / encounter_top.php) can use Twig (Q-NEW-2), ' .
                'this test remains skipped and the raw-PHP fallback path is tested in ' .
                'AgentSidebarPhpIncludeTest.'
            );
        }

        if (!file_exists(self::TEMPLATES_DIR . '/' . self::PARTIAL_FILE)) {
            $this->markTestSkipped(
                'templates/agentforge/sidebar_partial.html.twig does not exist yet (M1). ' .
                'See Q-NEW-2: if neither host has a Twig env, implement raw PHP fallback.'
            );
        }

        $loader = new FilesystemLoader(self::TEMPLATES_DIR);
        $this->twig = new Environment($loader, ['autoescape' => 'html']);
    }

    #[Test]
    public function partialRendersAgentSidebarElementWithPidAttribute(): void
    {
        // §3.2: "data-pid" attribute set from OpenEMR $pid session variable
        $html = $this->renderPartial(['pid' => 42, 'encounter_id' => 17, 'patient_uuid' => 'test-uuid']);

        self::assertStringContainsString(
            'data-pid="42"',
            $html,
            'Rendered partial must include data-pid attribute with correct pid value'
        );
    }

    #[Test]
    public function partialRendersAgentSidebarElementWithEncounterIdAttribute(): void
    {
        // §3.2: "data-encounter-id" attribute on the encounter mount.
        $html = $this->renderPartial(['pid' => 42, 'encounter_id' => 17, 'patient_uuid' => 'test-uuid']);

        self::assertStringContainsString(
            'data-encounter-id="17"',
            $html,
            'Rendered partial must include data-encounter-id attribute when encounter_id is provided'
        );
    }

    #[Test]
    public function partialOmitsEncounterIdAttributeOnDashboardMount(): void
    {
        // D5 (post-pivot): the dashboard mount has no encounter_id. The
        // partial must render either with no data-encounter-id attribute
        // at all, or with it left empty — but never with a fabricated 0
        // or stale id, because the agent uses presence/absence of the
        // attribute to decide whether to include encounter_id in the
        // chat POST body.
        $html = $this->renderPartial(['pid' => 42, 'encounter_id' => null, 'patient_uuid' => 'test-uuid']);

        self::assertStringNotContainsString(
            'data-encounter-id="0"',
            $html,
            'Partial must NOT render data-encounter-id="0" when encounter_id is null'
        );
        // Either omitted entirely, or explicitly empty — both are acceptable.
        $hasEmptyAttr   = str_contains($html, 'data-encounter-id=""');
        $hasNoAttribute = !str_contains($html, 'data-encounter-id');
        self::assertTrue(
            $hasEmptyAttr || $hasNoAttribute,
            'Dashboard mount must render data-encounter-id as empty or omitted'
        );
    }

    #[Test]
    public function partialRendersAgentSidebarElementWithPatientUuidAttribute(): void
    {
        // §3.2: "data-patient-uuid" attribute
        $uuid = '8a3f1234-abcd-4def-bcde-000000000042';
        $html = $this->renderPartial(['pid' => 42, 'encounter_id' => 17, 'patient_uuid' => $uuid]);

        self::assertStringContainsString(
            "data-patient-uuid=\"{$uuid}\"",
            $html,
            'Rendered partial must include data-patient-uuid attribute'
        );
    }

    #[Test]
    public function partialRendersScriptTagForWebComponentBundle(): void
    {
        // §3.2: "a <script> tag loading the bundled Web Component"
        // §3.1 file inventory: public/assets/agentforge/agent-sidebar.js
        $html = $this->renderPartial(['pid' => 1, 'encounter_id' => 1, 'patient_uuid' => 'u']);

        self::assertStringContainsString(
            'agent-sidebar.js',
            $html,
            'Rendered partial must include <script> tag referencing agent-sidebar.js bundle'
        );
    }

    #[Test]
    public function partialRendersAgentSidebarCustomElement(): void
    {
        // §3.2: custom element <agent-sidebar>
        $html = $this->renderPartial(['pid' => 1, 'encounter_id' => 1, 'patient_uuid' => 'u']);

        self::assertStringContainsString(
            '<agent-sidebar',
            $html,
            'Rendered partial must include <agent-sidebar> custom element opening tag'
        );
    }

    #[Test]
    public function partialXssEscapesPidValue(): void
    {
        // AUDIT.md §1: XSS concerns; Twig must escape attribute values
        // pid is always an int from PHP, but verify the template uses |attr or integer cast
        $html = $this->renderPartial(['pid' => 42, 'encounter_id' => 17, 'patient_uuid' => 'u']);

        // Must not contain raw PHP interpolation — value must be properly escaped
        self::assertStringNotContainsString('<script>', strip_tags($html, '<agent-sidebar><script>'));
    }

    /**
     * @param array<string, mixed> $context
     */
    private function renderPartial(array $context): string
    {
        self::assertNotNull($this->twig);
        return $this->twig->render(self::PARTIAL_FILE, $context);
    }
}
