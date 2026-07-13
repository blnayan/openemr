/**
 * Persistent patient identity strip. Renders below the OpenEMR top bar and
 * stays visible at any scroll position — the brief's response to "physicians
 * lose track of which chart they're in during long scrolls".
 *
 * This component is *presentational over a `PatientDTO`*. Loading / error /
 * empty states are owned by the caller (App.tsx) so the strip itself only
 * renders the happy path. Future card components follow the same split.
 */

import React from 'react';

import type { PatientDTO } from '../fhir/schemas/patient';

interface IdentityStripProps {
  patient: PatientDTO;
  /** Test seam for deterministic age calculation. Defaults to `new Date()`. */
  now?: Date;
}

export function IdentityStrip({
  patient,
  now,
}: IdentityStripProps): React.JSX.Element {
  const age = patient.birthDate !== null
    ? computeAgeYears(patient.birthDate, now ?? new Date())
    : null;

  const fieldClass =
    'inline-flex items-baseline whitespace-nowrap px-3.5 border-r border-strip-divider first:pl-0 last:border-r-0';
  const labelClass =
    'text-ink-faint text-xs uppercase tracking-label mr-1.5';
  const monoClass = 'font-mono tabular-nums';

  return (
    <div
      className="flex items-center flex-wrap gap-0 py-2.25 px-6 bg-bg-strip border-b border-border text-base text-ink"
      data-testid="identity-strip"
    >
      <span className={fieldClass}>
        <span className="font-semibold text-ink text-lg">
          {patient.name !== '' ? patient.name : '(no name)'}
        </span>
      </span>

      <span className={fieldClass}>
        <span className={labelClass}>DOB</span>
        <span className={monoClass}>{patient.birthDate ?? '—'}</span>
        {age !== null ? (
          <span className="text-ink-muted ml-1.5">({age}y)</span>
        ) : null}
      </span>

      <span className={fieldClass}>
        <span className={labelClass}>Sex</span>
        <span>{formatGender(patient.gender)}</span>
      </span>

      <span className={fieldClass}>
        <span className={labelClass}>MRN</span>
        <span className={monoClass}>{patient.mrn !== '' ? patient.mrn : '—'}</span>
      </span>

      {patient.active ? (
        <span
          className={
            fieldClass
            + ' text-ok font-medium before:content-["●"] before:mr-1'
          }
        >
          Active
        </span>
      ) : null}
    </div>
  );
}

/**
 * Display-friendly gender label. We don't translate FHIR's full code set —
 * just capitalize the four allowed values. Internationalization is explicit
 * out-of-scope per the PRD.
 */
function formatGender(gender: string | null): string {
  if (gender === null || gender === '') {
    return 'Unknown';
  }
  return gender.charAt(0).toUpperCase() + gender.slice(1).toLowerCase();
}

/**
 * Compute age in completed years from an ISO `YYYY-MM-DD` birth date.
 *
 * Uses local-time date math because clinicians read the strip in their own
 * timezone; UTC math would tip the age over a day early for late-night
 * births in western timezones.
 */
export function computeAgeYears(birthDateIso: string, now: Date): number {
  const parts = birthDateIso.split('-');
  if (parts.length !== 3) {
    return Number.NaN;
  }
  const y = parseInt(parts[0] ?? '', 10);
  const m = parseInt(parts[1] ?? '', 10);
  const d = parseInt(parts[2] ?? '', 10);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) {
    return Number.NaN;
  }
  let age = now.getFullYear() - y;
  const beforeBirthdayThisYear =
    now.getMonth() + 1 < m
    || (now.getMonth() + 1 === m && now.getDate() < d);
  if (beforeBirthdayThisYear) {
    age -= 1;
  }
  return age;
}
