/**
 * Lab Results card — recent lab observations for the patient.
 *
 * Backed by FHIR `Observation?category=laboratory`. Out-of-range values are
 * surfaced via a red foreground on the *value only* — NOT a tinted full-row
 * background (per W2 PRD, tinted rows are reserved for the safety-critical
 * Allergies card). The flag bucket comes from
 * `interpretLabFlag(Observation.interpretation codes)` — we trust the lab
 * system's interpretation rather than re-deriving from `referenceRange`.
 *
 * Rows render two lines: a primary "name … value" line, with optional
 * secondary line carrying the result date and reference range as dimmer
 * meta. Loading / error / empty states are handled in-card so a failure to
 * load labs is visible at the card location, not bumped up to a shell-level
 * error.
 */

import React from 'react';

import { useLabResults } from '../fhir/hooks/useLabResults';
import type { LabObservationDTO } from '../fhir/schemas/observation';
import type { LabFlag } from '../clinical/labFlag';

import { Card } from './Card';
import { openCardEditor } from './cardEditUrls';

const STATUS_ROW = 'text-base py-1 text-ink-muted';
const VALUE_BASE = 'text-ink tabular-nums';
const VALUE_FLAGGED = 'text-severe font-semibold';

interface LabResultsCardProps {
  patientId: string;
  accessToken: string;
  userId?: string | null;
  pid?: string | null;
}

export function LabResultsCard({
  patientId,
  accessToken,
  userId = null,
  pid = null,
}: LabResultsCardProps): React.JSX.Element {
  const query = useLabResults(patientId, accessToken);

  return (
    <Card
      title="Lab Results"
      cardId="labResults"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={() => openCardEditor('labResults')}
      data-testid="lab-results-card"
    >
      <LabResultsBody query={query} />
    </Card>
  );
}

interface LabResultsBodyProps {
  query: ReturnType<typeof useLabResults>;
}

function LabResultsBody({ query }: LabResultsBodyProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load lab results.
      </div>
    );
  }
  const labs = query.data ?? [];
  if (labs.length === 0) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  return (
    <ul
      className="list-none m-0 p-0 flex flex-col"
      data-testid="lab-results-list"
    >
      {labs.map((o) => (
        <LabRow key={o.id} observation={o} />
      ))}
    </ul>
  );
}

interface LabRowProps {
  observation: LabObservationDTO;
}

function isFlagged(flag: LabFlag): boolean {
  return flag !== 'normal';
}

function formatEffectiveDate(iso: string): string {
  // Show only the date portion. We rely on lexicographic ISO ordering for
  // sort (in the hook) and don't need locale-specific formatting here —
  // the row's date is meta info, not the primary signal.
  const tIndex = iso.indexOf('T');
  return tIndex === -1 ? iso : iso.slice(0, tIndex);
}

function LabRow({ observation }: LabRowProps): React.JSX.Element {
  const flagged = isFlagged(observation.flag);
  const valueClass = flagged ? `${VALUE_BASE} ${VALUE_FLAGGED}` : VALUE_BASE;
  const showMeta
    = observation.effectiveDateTime !== null
      || observation.referenceRange !== null;

  return (
    <li
      className="py-1 text-base text-ink flex flex-col"
      data-testid="lab-row"
      data-flag={observation.flag}
    >
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-ink">
          {observation.name !== '' ? observation.name : '(unnamed test)'}
        </span>
        <span className={valueClass} data-testid="lab-value">
          {observation.valueDisplay}
        </span>
      </div>
      {showMeta ? (
        <div className="text-ink-muted text-sm flex justify-between gap-2">
          <span data-testid="lab-date">
            {observation.effectiveDateTime !== null
              ? formatEffectiveDate(observation.effectiveDateTime)
              : ''}
          </span>
          <span data-testid="lab-range">
            {observation.referenceRange ?? ''}
          </span>
        </div>
      ) : null}
    </li>
  );
}
