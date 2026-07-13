/**
 * Medications card — plain-row list of the patient's currently active
 * medications.
 *
 * Backed by FHIR `MedicationRequest` (not `MedicationStatement`, which
 * OpenEMR's FHIR server does not implement). The same underlying resource
 * feeds the Prescriptions card (#28); the two cards diverge in their
 * hook-level filters (this one keeps `status === 'active'`; #28 narrows by
 * `intent`). See `useMedications` for the filter rationale.
 *
 * Like ProblemsCard, rows here carry no severity tint (per W2 PRD, tinted
 * full-row backgrounds are reserved for the safety-critical Allergies
 * card). Each row shows the medication name, with the dosing instruction
 * — when available — rendered as a dimmer secondary line beneath it.
 *
 * Loading / error / empty states are handled in-card so a failure to load
 * medications is visible at the card location, not bumped up to a
 * shell-level error.
 */

import React from 'react';

import { useMedications } from '../fhir/hooks/useMedications';
import type { MedicationRequestDTO } from '../fhir/schemas/medicationRequest';

import { Card } from './Card';
import { openCardEditor } from './cardEditUrls';

const STATUS_ROW = 'text-base py-1 text-ink-muted';

interface MedicationsCardProps {
  patientId: string;
  accessToken: string;
  userId?: string | null;
  pid?: string | null;
}

export function MedicationsCard({
  patientId,
  accessToken,
  userId = null,
  pid = null,
}: MedicationsCardProps): React.JSX.Element {
  const query = useMedications(patientId, accessToken);

  return (
    <Card
      title="Medications"
      cardId="medications"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={() => openCardEditor('medications')}
      data-testid="medications-card"
    >
      <MedicationsBody query={query} />
    </Card>
  );
}

interface MedicationsBodyProps {
  query: ReturnType<typeof useMedications>;
}

function MedicationsBody({ query }: MedicationsBodyProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load medications.
      </div>
    );
  }
  const meds = query.data ?? [];
  if (meds.length === 0) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  return (
    <ul
      className="list-none m-0 p-0 flex flex-col"
      data-testid="medications-list"
    >
      {meds.map((m) => (
        <MedicationRow key={m.id} medication={m} />
      ))}
    </ul>
  );
}

interface MedicationRowProps {
  medication: MedicationRequestDTO;
}

function MedicationRow({ medication }: MedicationRowProps): React.JSX.Element {
  return (
    <li
      className="py-1 text-base text-ink flex flex-col"
      data-testid="medication-row"
    >
      <span>{medication.name}</span>
      {medication.dosingText !== null && medication.dosingText.length > 0 ? (
        <span
          className="text-ink-muted text-sm"
          data-testid="medication-dosing"
        >
          {medication.dosingText}
        </span>
      ) : null}
    </li>
  );
}
