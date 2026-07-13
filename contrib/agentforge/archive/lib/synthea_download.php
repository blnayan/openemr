<?php

/**
 * Synthea sample-data resolver.
 *
 * The Synthea 100-patient CSV pack is vendored into the repo at
 * contrib/agentforge/data/synthea_sample_data_csv.zip — that lets the seeder
 * run on Railway with no outbound network, and it pins us to a known set of
 * bytes (SHA-256 in synthea_sample_data_csv.zip.sha256) instead of whatever
 * GitHub Pages happens to serve as "latest" on the day we deploy.
 *
 * This class extracts that vendored zip once into a writable cache dir and
 * hands the directory of CSV files to the loader. If the vendored zip is
 * missing (e.g. someone shallow-cloned without LFS, or a future contributor
 * removed it), and the AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD env var is truthy,
 * we fall back to fetching from the upstream URL — but the default is
 * "no network".
 *
 * Source: https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip
 *
 * @package OpenEMR
 * @license https://github.com/openemr/openemr/blob/master/LICENSE GNU GPL 3
 */

declare(strict_types=1);

namespace OpenEMR\AgentForge\DemoSeed;

final class SyntheaDownloader
{
    public const ZIP_URL = 'https://synthetichealth.github.io/synthea-sample-data/downloads/latest/synthea_sample_data_csv_latest.zip';

    /** Path of the vendored zip relative to this file's directory. */
    private const VENDORED_ZIP_RELATIVE_PATH = '/../data/synthea_sample_data_csv.zip';

    /**
     * Canonical anchor file: if this exists in the extracted directory,
     * we treat the pack as already extracted. Chosen because patients.csv
     * is the smallest CSV in the pack and the loader cannot run without it.
     */
    private const ANCHOR_FILE = 'patients.csv';

    /**
     * Make sure the Synthea CSVs are extracted under $cacheDir and return
     * the directory holding the *.csv files.
     *
     * Resolution order:
     *   1. $cacheDir/csv/patients.csv already extracted → use as-is
     *   2. Vendored zip exists in repo → extract it
     *   3. AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD truthy → download from upstream
     *   4. Otherwise throw — never silently reach for the network.
     */
    public static function ensureCsvDir(string $cacheDir, bool $quiet = false): string
    {
        if (!is_dir($cacheDir) && !mkdir($cacheDir, 0775, true) && !is_dir($cacheDir)) {
            throw new \RuntimeException("could not create cache dir $cacheDir");
        }

        $csvDir = $cacheDir . '/csv';
        if (is_file($csvDir . '/' . self::ANCHOR_FILE)) {
            return $csvDir;
        }

        $sourceZip = self::resolveZipSource($cacheDir, $quiet);
        @mkdir($csvDir, 0775, true);

        $zip = new \ZipArchive();
        if ($zip->open($sourceZip) !== true) {
            throw new \RuntimeException("could not open $sourceZip");
        }
        $zip->extractTo($csvDir);
        $zip->close();

        if (!is_file($csvDir . '/' . self::ANCHOR_FILE)) {
            throw new \RuntimeException(
                "synthea zip $sourceZip extracted no " . self::ANCHOR_FILE . " into $csvDir"
            );
        }
        return $csvDir;
    }

    private static function resolveZipSource(string $cacheDir, bool $quiet): string
    {
        // Vendored: highest priority.
        $vendored = realpath(__DIR__ . self::VENDORED_ZIP_RELATIVE_PATH);
        if ($vendored !== false && is_file($vendored)) {
            if (!$quiet) {
                fwrite(STDOUT, "Using vendored Synthea CSV pack: $vendored\n");
            }
            return $vendored;
        }

        // Already-cached download in $cacheDir.
        $cached = $cacheDir . '/synthea_sample_data_csv.zip';
        if (is_file($cached)) {
            return $cached;
        }

        if (!self::networkAllowed()) {
            throw new \RuntimeException(
                'Synthea CSV zip not found at ' . __DIR__ . self::VENDORED_ZIP_RELATIVE_PATH
                . ' and AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD is not set — refusing to fetch from the network.'
                . ' Restore the vendored zip or set AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD=1 to download.'
            );
        }

        self::download(self::ZIP_URL, $cached, $quiet);
        return $cached;
    }

    private static function networkAllowed(): bool
    {
        $flag = getenv('AGENTFORGE_SYNTHEA_ALLOW_DOWNLOAD');
        if ($flag === false) {
            return false;
        }
        return in_array(strtolower($flag), ['1', 'true', 'yes', 'on'], true);
    }

    private static function download(string $url, string $destPath, bool $quiet): void
    {
        if (!$quiet) {
            fwrite(STDOUT, "Downloading $url → $destPath\n");
        }
        $ch = curl_init($url);
        $fp = fopen($destPath, 'wb');
        if ($ch === false || $fp === false) {
            throw new \RuntimeException('failed to open download stream');
        }
        curl_setopt_array($ch, [
            CURLOPT_FILE             => $fp,
            CURLOPT_FOLLOWLOCATION   => true,
            CURLOPT_FAILONERROR      => true,
            CURLOPT_TIMEOUT          => 300,
            CURLOPT_CONNECTTIMEOUT   => 30,
            CURLOPT_SSL_VERIFYPEER   => false,
            CURLOPT_USERAGENT        => 'agentforge-seeder',
        ]);
        $ok  = curl_exec($ch);
        $err = curl_error($ch);
        curl_close($ch);
        fclose($fp);
        if (!$ok) {
            @unlink($destPath);
            throw new \RuntimeException("synthea download failed: $err");
        }
    }
}
