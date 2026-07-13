/**
 * Lint guard — fails if any module under `agent/src/` directly imports
 * from `langsmith`, `langsmith/traceable`, or `langfuse` outside the sanctioned
 * wrapper at `src/observability/tracedClient.ts`.
 *
 * Why this is a test, not a config rule: it lives in the test suite so
 * it runs on CI without needing an additional ESLint plugin, and so a
 * regression is visible as a failing test rather than a yellow lint
 * warning. Modeled after the project's PHPStan custom-rules pattern.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(here, '..', '..', '..', 'src');
const ALLOWED_FILES = new Set<string>([
  resolve(SRC_ROOT, 'observability', 'tracedClient.ts'),
]);

const FORBIDDEN_RE = /from\s+['"](langsmith(?:\/[a-z]+)?|langfuse)['"]/g;

function walk(dir: string): readonly string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('observability lint guard', () => {
  it('no source file outside the wrapper imports observability SDKs directly', () => {
    const offenders: Array<{ file: string; matches: readonly string[] }> = [];
    for (const file of walk(SRC_ROOT)) {
      if (ALLOWED_FILES.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      const matches = text.match(FORBIDDEN_RE);
      if (matches && matches.length > 0) {
        offenders.push({
          file: file.split(sep + 'src' + sep)[1] ?? file,
          matches,
        });
      }
    }
    expect(
      offenders,
      `Found direct observability SDK imports outside the wrapper:\n${JSON.stringify(offenders, null, 2)}\n` +
        'Import from `src/observability/index.ts` (tracedTraceable / createTracedClient) instead.',
    ).toEqual([]);
  });
});
