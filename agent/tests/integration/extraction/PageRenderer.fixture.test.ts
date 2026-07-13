/**
 * Integration smoke test for ImageAndPdfPageRenderer against a real
 * fixture PDF. Skipped if the fixture isn't present on disk so CI
 * environments without the fixtures bundle don't fail this suite.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImageAndPdfPageRenderer } from '../../../src/extraction/PageRenderer.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_PATH = resolve(here, '../../../data/fixtures/lab-results/p01-chen-lipid-panel.pdf');

const fixturePresent = existsSync(FIXTURE_PATH);

describe.skipIf(!fixturePresent)('ImageAndPdfPageRenderer (fixture)', () => {
  it('renders the lipid-panel PDF fixture to multiple PNG pages', async () => {
    const bytes = readFileSync(FIXTURE_PATH);
    const renderer = new ImageAndPdfPageRenderer();
    const pages = await renderer.render({ bytes, mimeType: 'application/pdf' });

    expect(pages.length).toBeGreaterThanOrEqual(1);
    pages.forEach((p, idx) => {
      expect(p.page).toBe(idx);
      expect(p.imageWidth).toBeGreaterThan(0);
      expect(p.imageHeight).toBeGreaterThan(0);
      expect(p.pngBytes.length).toBeGreaterThan(0);
      // Sanity: a real letter-sized PDF rendered at 2.0x should produce
      // at least a few-hundred-pixel canvas in each dimension.
      expect(p.imageWidth).toBeGreaterThanOrEqual(200);
      expect(p.imageHeight).toBeGreaterThanOrEqual(200);
    });
  });
});
