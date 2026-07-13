<?php

/**
 * Isolated tests for SyntheaLoader CSV parsing helpers.
 *
 * Exercises the pure-function helpers (race / ethnicity / diagnosis /
 * encounter-class / pubpid / name-suffix) that translate Synthea CSV
 * fields into OpenEMR-shaped values. No database, no OpenEMR session,
 * no service instantiation — these tests run on the host without Docker.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\AgentForge\DemoSeed;

use OpenEMR\AgentForge\DemoSeed\SyntheaLoader;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Test;
use PHPUnit\Framework\TestCase;

require_once dirname(__DIR__, 5) . '/contrib/agentforge/lib/SyntheaLoader.php';

#[CoversClass(SyntheaLoader::class)]
final class SyntheaCsvParserIsolatedTest extends TestCase
{
    #[Test]
    #[DataProvider('raceProvider')]
    public function mapsRace(string $raw, string $expected): void
    {
        self::assertSame($expected, SyntheaLoader::mapRace($raw));
    }

    /**
     * @return array<string, array{string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function raceProvider(): array
    {
        return [
            'white'        => ['white', 'White'],
            'black'        => ['black', 'Black or African American'],
            'asian'        => ['asian', 'Asian'],
            'native'       => ['native', 'American Indian or Alaska Native'],
            'hawaiian'     => ['hawaiian', 'Native Hawaiian or Other Pacific Islander'],
            'other'        => ['other', 'Other'],
            'mixed case'   => ['White', 'White'],
            'leading ws'   => ['  asian  ', 'Asian'],
            'unknown'      => ['martian', ''],
            'empty'        => ['', ''],
        ];
    }

    #[Test]
    #[DataProvider('ethnicityProvider')]
    public function mapsEthnicity(string $raw, string $expected): void
    {
        self::assertSame($expected, SyntheaLoader::mapEthnicity($raw));
    }

    /**
     * @return array<string, array{string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function ethnicityProvider(): array
    {
        return [
            'hispanic'     => ['hispanic', 'hisp_or_latin'],
            'nonhispanic'  => ['nonhispanic', 'not_hisp_or_latin'],
            'mixed case'   => ['Hispanic', 'hisp_or_latin'],
            'whitespace'   => [' nonhispanic ', 'not_hisp_or_latin'],
            'unknown'      => ['latinx', ''],
            'empty'        => ['', ''],
        ];
    }

    #[Test]
    #[DataProvider('diagnosisProvider')]
    public function buildsCsvDiagnosis(string $system, string $code, string $expected): void
    {
        self::assertSame($expected, SyntheaLoader::csvDiagnosis($system, $code));
    }

    /**
     * @return array<string, array{string, string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function diagnosisProvider(): array
    {
        return [
            'snomed url'      => ['http://snomed.info/sct', '105531004', 'SNOMED-CT:105531004'],
            'snomed token'    => ['SNOMED-CT', '609328004', 'SNOMED-CT:609328004'],
            'loinc url'       => ['http://loinc.org', '8302-2', 'LOINC:8302-2'],
            'rxnorm url'      => ['http://www.nlm.nih.gov/research/umls/rxnorm', '313782', 'RXNORM:313782'],
            'icd10 token'     => ['ICD-10', 'E11.9', 'ICD10:E11.9'],
            'unknown system'  => ['urn:made-up', 'xyz', 'SNOMED-CT:xyz'],
            'empty system'    => ['', '12345', 'SNOMED-CT:12345'],
            'empty code'      => ['http://loinc.org', '', ''],
        ];
    }

    #[Test]
    #[DataProvider('encounterClassProvider')]
    public function mapsEncounterClass(string $raw, string $expected): void
    {
        self::assertSame($expected, SyntheaLoader::mapEncounterClass($raw));
    }

    /**
     * @return array<string, array{string, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function encounterClassProvider(): array
    {
        return [
            'ambulatory'     => ['ambulatory', 'AMB'],
            'wellness fallback' => ['wellness', 'AMB'],
            'outpatient'     => ['outpatient', 'AMB'],
            'urgentcare'     => ['urgentcare', 'AMB'],
            'emergency'      => ['emergency', 'EMER'],
            'inpatient'      => ['inpatient', 'IMP'],
            'home'           => ['home', 'HH'],
            'virtual'        => ['virtual', 'VR'],
            'empty fallback' => ['', 'AMB'],
            'unknown fallback' => ['spaceflight', 'AMB'],
            'pre-uppercased AMB' => ['AMB', 'AMB'],
            'allowed code passthrough' => ['EMER', 'EMER'],
        ];
    }

    #[Test]
    public function stripsSyntheaNumericSuffix(): void
    {
        self::assertSame('Maurice', SyntheaLoader::stripSyntheaSuffix('Maurice742'));
        self::assertSame('Brekke', SyntheaLoader::stripSyntheaSuffix('Brekke496'));
        self::assertSame('Plain', SyntheaLoader::stripSyntheaSuffix('Plain'));
        self::assertSame('', SyntheaLoader::stripSyntheaSuffix(''));
    }

    #[Test]
    public function buildsAgentForgePubpid(): void
    {
        $pubpid = SyntheaLoader::buildPubpid('f1aa52b9-aded-3188-9386-012244805ebf');
        self::assertStringStartsWith('AGENTFORGE-', $pubpid);
        // 11 char prefix + 24 char compacted id = 35 char total
        self::assertSame(35, strlen($pubpid));
        self::assertSame('AGENTFORGE-f1aa52b9aded31889386', $pubpid);
    }

    #[Test]
    public function pubpidPrefixIsStable(): void
    {
        // The reset path in DemoDataSeeder matches this prefix; it must not
        // change without coordinated update there.
        self::assertSame('AGENTFORGE-', SyntheaLoader::DEMO_PUBPID_PREFIX);
    }

    #[Test]
    #[DataProvider('socialDeterminantCodeProvider')]
    public function flagsSocialDeterminantCodesAsNonMedical(string $code, bool $expected): void
    {
        // Synthea ships findings like "Full-time employment" and
        // "Housing unsatisfactory" in conditions.csv. These are social
        // determinants of health, not medical conditions, and must not
        // land on the OpenEMR problem list.
        self::assertSame($expected, SyntheaLoader::isNonMedicalCondition($code));
    }

    /**
     * @return array<string, array{string, bool}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function socialDeterminantCodeProvider(): array
    {
        return [
            // Filtered: Synthea social-determinants module
            'full-time employment'   => ['160903007', true],
            'part-time employment'   => ['160904001', true],
            'unemployed'             => ['73438004', true],
            'not in labor force'     => ['741062008', true],
            'housing unsatisfactory' => ['105531004', true],
            'received higher ed'     => ['224299000', true],
            'high school education'  => ['473461003', true],
            'social isolation'       => ['422650009', true],
            'limited social contact' => ['423315002', true],
            'stress finding'         => ['73595000', true],
            'refugee'                => ['446654005', true],
            'transport problem'      => ['266934004', true],
            'criminal record'        => ['266948004', true],
            'lack of transport'      => ['713458007', true],
            'violence reports'       => ['424393004', true],
            'IPV victim'             => ['706893006', true],
            'risk activity'          => ['160968000', true],
            'primary education'      => ['224295006', true],

            // Kept: real medical conditions and surgical history
            'opioid abuse (real disorder)'         => ['5602001', false],
            'dependent drug abuse (real disorder)' => ['6525002', false],
            'acute respiratory distress syndrome'  => ['67782005', false],
            'kidney transplant failure'            => ['213150003', false],
            'transformed migraine'                 => ['427419006', false],
            'history renal transplant'             => ['161665007', false],
            'awaiting kidney transplant'           => ['698306007', false],
            'empty code'                           => ['', false],
            'unknown code'                         => ['9999999999', false],
        ];
    }
}
