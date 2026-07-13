/**
 * Allergies card.
 *
 * Each row shows the allergen name as the primary line and the severity
 * bucket as a dimmer secondary line beneath — same two-line pattern as
 * MedicationsCard's `name + dose` rows. Severity-tinted full-row
 * backgrounds were tried but the user reverted them; the bucket
 * classification still drives the displayed label so a clinician can
 * scan severity without a color cue.
 *
 * Loading / error / empty states are handled inside this card (rather
 * than by the caller) because the card is the unit of perception on
 * the dashboard — failing to load allergies is itself a safety signal
 * that needs to be visible in-place, not bumped up to a shell-level
 * error.
 */

import React from 'react';

import { useAllergies } from '../fhir/hooks/useAllergies';
import {
  interpretAllergySeverity,
  type AllergySeverityBucket,
} from '../clinical/severity';
import type { AllergyDTO } from '../fhir/schemas/allergyIntolerance';

import { Card } from './Card';
import { openCardEditor } from './cardEditUrls';

interface AllergiesCardProps {
  patientId: string;
  accessToken: string;
  /** Logged-in user id; threaded through to the collapse-state hook. */
  userId?: string | null;
  /** Patient context for the collapse-state hook. */
  pid?: string | null;
}

const SEVERITY_LABEL: Record<AllergySeverityBucket, string> = {
  moderate: 'Moderate',
  mild: 'Mild',
  unknown: 'Unknown',
};

// Tailwind color class per severity bucket — applied to the leading
// dot. Tints stay scoped to a small circle, not the full row.
const SEVERITY_DOT_CLASS: Record<AllergySeverityBucket, string> = {
  moderate: 'text-severe',
  mild: 'text-warn',
  unknown: 'text-ink-faint',
};

export function AllergiesCard({
  patientId,
  accessToken,
  userId = null,
  pid = null,
}: AllergiesCardProps): React.JSX.Element {
  const query = useAllergies(patientId, accessToken);

  return (
    <Card
      title="Allergies"
      cardId="allergies"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={() => openCardEditor('allergies')}
      data-testid="allergies-card"
    >
      <AllergiesBody query={query} />
    </Card>
  );
}

interface AllergiesBodyProps {
  query: ReturnType<typeof useAllergies>;
}

const STATUS_ROW = 'text-base py-1 text-ink-muted';

function AllergiesBody({ query }: AllergiesBodyProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load allergies.
      </div>
    );
  }
  const allergies = query.data ?? [];
  if (allergies.length === 0) {
    return <div className={STATUS_ROW}>No Known Allergies</div>;
  }
  return (
    <ul
      className="list-none m-0 p-0 flex flex-col"
      data-testid="allergies-list"
    >
      {allergies.map((a) => (
        <AllergyRow key={a.id} allergy={a} />
      ))}
    </ul>
  );
}

interface AllergyRowProps {
  allergy: AllergyDTO;
}

function AllergyRow({ allergy }: AllergyRowProps): React.JSX.Element {
  const bucket = interpretAllergySeverity(
    allergy.criticality,
    allergy.reactionSeverity,
  );
  return (
    <li
      className="py-1 text-base text-ink flex flex-col"
      data-severity={bucket}
      data-testid="allergy-row"
    >
      <span>
        {allergy.name !== '' ? allergy.name : '(unnamed allergen)'}
      </span>
      <span className="text-ink-muted text-sm inline-flex items-center gap-1">
        <span
          className={`${SEVERITY_DOT_CLASS[bucket]} leading-none`}
          aria-hidden="true"
        >
          ●
        </span>
        {SEVERITY_LABEL[bucket]}
      </span>
    </li>
  );
}
