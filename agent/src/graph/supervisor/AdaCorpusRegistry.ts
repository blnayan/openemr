/**
 * AdaCorpusRegistry — static implementation of GuidelineCorpusRegistry
 * backed by the in-process ADA corpus JSON. Counted at module init so
 * subsequent calls are O(1). Tests inject a stub registry directly.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type {
  GuidelineCorpusRegistry,
} from './availabilityHint.js';
import type { GuidelineCorpusSummary } from './types.js';

export class StaticGuidelineCorpusRegistry implements GuidelineCorpusRegistry {
  constructor(private readonly entries: readonly GuidelineCorpusSummary[]) {}
  list(): readonly GuidelineCorpusSummary[] { return this.entries; }
}
