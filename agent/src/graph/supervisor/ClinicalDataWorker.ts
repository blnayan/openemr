/**
 * ClinicalDataWorker — wraps the Week-1 clinical-data graph
 * (router/planner/tools/verifier/formatter) behind the supervisor's
 * uniform worker interface.
 *
 * The supervisor calls this worker with `{question, pid}` and gets
 * back the existing Week-1 `Answer` plus the underlying tool transcript
 * — the supervisor-level verifier needs the transcript so it can
 * resolve every `patient_record` citation against actual tool rows.
 *
 * Why we wrap rather than reimplement: Week 1 is mature, has its own
 * refusal-router / verifier / Layer-2 rule engine, and any divergence
 * here would silently weaken those guards. The dispatcher interface
 * is constructor-injected so tests substitute deterministic
 * transcripts and so the production wiring (`runFollowup`) lives at
 * the chat-route level where the conversation cache already exists.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

import type { ClinicalDataDispatcher, ClinicalDataOutput } from './types.js';

export class ClinicalDataWorker {
  constructor(private readonly dispatcher: ClinicalDataDispatcher) {}

  async run(input: { readonly question: string; readonly pid: number }):
    Promise<ClinicalDataOutput> {
    const result = await this.dispatcher.run(input);
    return {
      worker: 'clinical_data',
      answer: result.answer,
      toolResults: result.toolResults,
    };
  }
}
