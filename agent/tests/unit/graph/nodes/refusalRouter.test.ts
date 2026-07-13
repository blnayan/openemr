/**
 * Refusal router unit tests.
 *
 * Locks in the deterministic out-of-scope classification used by both
 * runFollowup and (after this change) the supervisor path. Each test
 * is a single (question, expected reason | null) tuple — kept flat so
 * a future maintainer can grep for the substring that triggered a
 * regression.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyOutOfScope,
  type PatientName,
} from '../../../../src/graph/nodes/refusalRouter.js';

const CHEN: PatientName = { given: 'Margaret', family: 'Chen' };
const NO_NAME: PatientName = { given: null, family: null };

describe('refusalRouter — order_entry', () => {
  it.each([
    'Order a CBC and lipid panel for today',
    'Place an order for a basic metabolic panel',
    'Prescribe a new RX for amoxicillin',
    'Refill her metformin prescription',
  ])('refuses %s', (q) => {
    const r = classifyOutOfScope(q, CHEN);
    expect(r?.reason).toBe('order_entry');
    expect(r?.message).toMatch(/read-only/i);
  });

  it('does NOT refuse when "order" appears without an orderable noun', () => {
    expect(classifyOutOfScope('What was the order of her last three encounters?', CHEN)).toBeNull();
  });
});

describe('refusalRouter — multi_patient', () => {
  it.each([
    'List every patient with diabetes',
    'Show me all patients in the database',
    'Enumerate patients on metformin',
  ])('refuses %s', (q) => {
    const r = classifyOutOfScope(q, CHEN);
    expect(r?.reason).toBe('multi_patient');
  });
});

describe('refusalRouter — general_knowledge', () => {
  it.each([
    "What's a normal A1c for an adult?",
    'What is the typical fasting glucose range?',
    'Define cutoff for hypertension',
  ])('refuses %s', (q) => {
    const r = classifyOutOfScope(q, CHEN);
    expect(r?.reason).toBe('general_knowledge');
    expect(r?.message).toMatch(/scoped/i);
  });

  it('does NOT refuse a patient-specific lab question even though it starts with "what"', () => {
    expect(classifyOutOfScope("What's her latest A1c?", CHEN)).toBeNull();
  });
});

describe('refusalRouter — off_corpus_authority', () => {
  // The retrieval corpus is ADA-only. Any explicit mention of another
  // guideline body should refuse rather than silently substitute ADA
  // (the OUT-OF-CORPUS-8 hallucination we caught in eval).
  it.each([
    ['ACC/AHA cholesterol guideline LDL-C threshold for PCSK9?',                     'ACC/AHA'],
    ['Per the American College of Cardiology, when do we add ezetimibe?',           'ACC/AHA'],
    ['What does USPSTF recommend for colorectal screening?',                         'USPSTF'],
    ['Per the U.S. Preventive Services Task Force, screening interval?',             'USPSTF'],
    ['AAFP guidance on adult immunization?',                                         'AAFP'],
    ['ACOG recommendation for gestational diabetes screening?',                      'ACOG'],
    ['Per JNC-8, target BP for adults over 60?',                                     'JNC'],
    ['What does NICE guideline NG28 say about metformin?',                           'NICE'],
    ['Per KDIGO, when should we refer for nephrology?',                              'KDIGO'],
  ])('refuses %s as %s', (q, label) => {
    const r = classifyOutOfScope(q, CHEN);
    expect(r?.reason).toBe('off_corpus_authority');
    expect(r?.message).toContain(label);
  });

  it('does NOT refuse questions that mention ADA (the in-corpus authority)', () => {
    expect(classifyOutOfScope('Per ADA 2026, what is the A1c goal for this patient?', CHEN)).toBeNull();
  });

  it('does NOT trip on the bare word "guideline" without a named authority', () => {
    expect(classifyOutOfScope('What does the diabetes guideline say about her A1c?', CHEN)).toBeNull();
  });

  // Generic specialty-society catch-all. These would have tripped
  // wrong_patient (Title-Case bigram) before the org-token filter and
  // the catch-all regex were added.
  it.each([
    'What does the American College of Radiology recommend for low back pain imaging?',
    'Per the American College of Surgeons, when do we operate?',
    'European Society of Cardiology guidance on ACS?',
    'Per the Royal College of Physicians, what is the threshold?',
    'What does the Surviving Sepsis Campaign recommend for hour-1 bundle?',
  ])('refuses %s as off_corpus_authority (not wrong_patient)', (q) => {
    const r = classifyOutOfScope(q, CHEN);
    expect(r?.reason).toBe('off_corpus_authority');
  });
});

describe('refusalRouter — wrong_patient organizational denylist', () => {
  // Title-Case bigrams that look organizational must NOT trigger
  // wrong_patient. Before the denylist these all crashed into the
  // "please open his chart for X" refusal, which is wrong and
  // confusing because the X is a guideline body, not a person.
  it.each([
    'American College advice on X',
    'National Institute guidance',
    'World Health initiatives',
    'Joint Commission standards',
    'British Hospital protocols',
    'Surviving Cancer education',
  ])('skips wrong_patient on organizational bigram in %s', (q) => {
    const r = classifyOutOfScope(q, CHEN);
    // May still match an authority pattern; we just want to confirm
    // it's never a wrong_patient.
    expect(r?.reason).not.toBe('wrong_patient');
  });
});

describe('refusalRouter — wrong_patient', () => {
  it('refuses when the question names a different patient', () => {
    const r = classifyOutOfScope('Tell me about James Lee, the other patient on my schedule.', CHEN);
    expect(r?.reason).toBe('wrong_patient');
    expect(r?.message).toContain('James Lee');
  });

  it('does NOT refuse when the bigram includes the current patient', () => {
    expect(classifyOutOfScope('Has Margaret Chen had a recent A1c?', CHEN)).toBeNull();
  });

  it('does not crash when patient name is missing — falls through to no refusal', () => {
    expect(classifyOutOfScope('Tell me about Sarah Connor.', NO_NAME)).toBeNull();
  });
});

describe('refusalRouter — order priority', () => {
  // off_corpus_authority must win over wrong_patient when a question
  // mentions both an authority and a Title-Case bigram. Authority
  // refusals are more specific (point at the right reference) and the
  // user shouldn't be told "open his chart" when they asked about a
  // guideline.
  it('prefers off_corpus_authority over wrong_patient on collision', () => {
    const r = classifyOutOfScope('Per ACC/AHA, has James Lee had a recent statin?', CHEN);
    expect(r?.reason).toBe('off_corpus_authority');
  });
});
