# Archived: legacy patient-summary entry points

The patient summary is now served by the React SPA at
`interface/patient_file/summary/dashboard/`. The legacy server-rendered
PHP page that previously lived at
`interface/patient_file/summary/demographics.php` is preserved here for
reference.

Status:
- Not loaded by Apache — moved out of the `interface/` tree.
- A thin redirect stub replaces the original at the legacy URL so any
  hardcoded caller still navigates to the dashboard.
- Restore by copying back into `interface/patient_file/summary/` if you
  ever need to roll back the dashboard.

The PRD that drove this migration is `prd/W2_PRD_PATIENT_DASHBOARD.md`.
