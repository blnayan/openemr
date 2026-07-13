# AgentForge demo fixtures

Eight real example documents and their pre-extracted JSON sidecars.
These are the canonical assets for the live demo flow:

- the demo flow uploads each document under one of the four
  `AGENTFORGE-DEMO-PDF-*` patients seeded by
  `contrib/agentforge/seed_demo_pdf_patients.php`;
- the deterministic eval suite reads the JSON sidecars as the source
  of truth, and the documents themselves are exercised only by the
  ingest-smoke suite that confirms the live extraction pipeline still
  works end-to-end.

The committed bytes are the user's example documents — **no synthetic
fixtures, no generator script**. Demographics in the JSON sidecars
match the values printed on the source documents verbatim.

## Fixture catalog

| File                                                | Doc type    | Patient (pubpid)            | Format             | One-line |
| --------------------------------------------------- | ----------- | --------------------------- | ------------------ | -------- |
| `lab-results/p01-chen-lipid-panel.pdf`              | lab_pdf     | AGENTFORGE-DEMO-PDF-001     | typed PDF (1 pg)   | Pacific Diagnostics Lab — total chol 232 H, HDL 48 L, LDL 158 H, trig 178 H, non-HDL 184 H. |
| `lab-results/p02-whitaker-cbc.pdf`                  | lab_pdf     | AGENTFORGE-DEMO-PDF-002     | typed PDF (1 pg)   | Desert Southwest Reference Lab — Hgb 11.1 L, Hct 33.5 L, RBC 3.78 L (mild normocytic anemia); WBC, MCV, plt normal. |
| `lab-results/p03-reyes-hba1c.png`                   | lab_pdf     | AGENTFORGE-DEMO-PDF-003     | scanned PNG        | Lone Star Laboratories — A1c 8.2 H, fasting glucose 152 H, eGFR 88 N. Uncontrolled T2DM. |
| `lab-results/p04-kowalski-cmp.pdf`                  | lab_pdf     | AGENTFORGE-DEMO-PDF-004     | typed PDF (1 pg)   | North Side Hospital Lab — CMP with Glu 108 H, BUN 28 H, Cr 1.4 H, eGFR 62 L, K 3.3 L, ALT 56 H, AST 48 H. |
| `intake-forms/p01-chen-intake-typed.pdf`            | intake_form | AGENTFORGE-DEMO-PDF-001     | typed PDF (3 pg)   | Berkeley Family Medical Group — chest tightness on exertion + family h/o MI; 4 meds, 3 allergies, 3 family-history rows. |
| `intake-forms/p02-whitaker-intake.pdf`              | intake_form | AGENTFORGE-DEMO-PDF-002     | typed PDF (2 pg)   | Sandia Foothills IM — fatigue + dizziness; 3 meds, NKDA, father h/o stroke. |
| `intake-forms/p03-reyes-intake.png`                 | intake_form | AGENTFORGE-DEMO-PDF-003     | scanned PNG        | South Lamar Family Medicine — blurry vision + neuropathy; metformin + Ozempic + sertraline; ibuprofen severe. |
| `intake-forms/p04-kowalski-intake.png`              | intake_form | AGENTFORGE-DEMO-PDF-004     | scanned PNG        | North Side Hospital ER triage — handwritten/messy; minimal extracted info beyond name and a multivitamin entry. |

Each document has a paired `pre-extracted/{base-without-extension}.json`
snapshot that is hand-typed, schema-validated against `LabPdfSchema` /
`IntakeFormSchema`, and guaranteed valid by
`tests/unit/fixtures/pre-extracted-shapes.test.ts`.

## Demo patients

Seeded by `contrib/agentforge/seed_demo_pdf_patients.php`. Demographics
are taken from the source documents verbatim:

| pubpid                       | Name                | DOB        | Sex | MRN              | Location                           |
| ---------------------------- | ------------------- | ---------- | --- | ---------------- | ---------------------------------- |
| `AGENTFORGE-DEMO-PDF-001`    | Margaret L. Chen    | 1967-08-14 | F   | MRN-2026-04481   | 4421 Magnolia Ave, Berkeley, CA    |
| `AGENTFORGE-DEMO-PDF-002`    | James E. Whitaker   | 1958-11-03 | M   | MRN-2026-04492   | Albuquerque, NM 87110              |
| `AGENTFORGE-DEMO-PDF-003`    | Sofia M. Reyes      | 1983-12-19 | F   | MRN-2026-04503   | 1124 South Lamar Blvd, Austin, TX  |
| `AGENTFORGE-DEMO-PDF-004`    | Robert Kowalski     | 1971-06-08 | M   | MRN-2026-04518   | Chicago, IL                        |

The pubpids share the `AGENTFORGE-` umbrella that the existing reset
path matches with `pubpid LIKE 'AGENTFORGE-%'`, so

    php contrib/agentforge/seed_demo_pdf_patients.php --reset-only

removes them in one shot. For a full demo wipe (including any data
from prior Synthea seeds) use:

    php contrib/agentforge/seed_demo_pdf_patients.php --clear-all-patients

The flag is destructive and logs a `WARNING:` line per patient deleted.

## Failure-mode coverage

The eight committed fixtures cover the extraction pipeline's primary
input surface:

- **typed digital PDF** (5 of 8) — direct text extraction path;
- **scanned image PNG** (3 of 8) — VLM-only path, no PDF text layer;
- **structured tabular labs** (4 of 4 lab fixtures) — exercises
  numeric value + reference-range + abnormal-flag extraction;
- **multi-section intakes with handwriting** (Reyes intake, Kowalski
  intake) — exercises low-confidence/blank handling.

## Refreshing pre-extracted JSON from a live extraction run

The committed JSONs are the source of truth. They are hand-typed
against the source-document text and validated by the shapes test
above. When the live OpenEMR Docker stack is up with valid
`OPENROUTER_API_KEY` and `AGENTFORGE_JWT_SECRET`, you can drive a
live ingest of every fixture (idempotent — already-extracted documents
are skipped):

```bash
node agent/scripts/seed-demo-fixtures.mjs
```

The script seeds the four demo patients, then walks
`intake-forms/` + `lab-results/` and shells out to
`contrib/agentforge/ingest_demo_fixture.php` for each fixture. The
PHP ingestor inserts the file into the AgentForge sub-category that
routes through `DocumentExtractionSubscriber`, which fires the live
extraction pipeline. The committed pre-extracted JSON files remain
authoritative for the eval suite — the live ingest is for the demo
flow, not for regenerating ground truth.
