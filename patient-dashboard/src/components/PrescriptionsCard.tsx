/**
 * Prescriptions card — plain-row list of the patient's active prescription
 * orders.
 *
 * Backed by FHIR `MedicationRequest` (the same resource that feeds the
 * Medications card; OpenEMR's FHIR server does not implement
 * `MedicationStatement`). The two cards diverge only in their hook-level
 * filter: this card narrows by `intent` to the order-family values, so it
 * shows actual prescription orders rather than plans / proposals / options.
 *
 * Rows here carry no severity tint — per W2 PRD, tinted full-row
 * backgrounds are reserved for the safety-critical Allergies card. Each row
 * shows the medication name, with the dosing instruction — when available
 * — rendered as a dimmer secondary line beneath it (mirroring
 * `MedicationsCard`'s row pattern for visual consistency).
 *
 * Loading / error / empty states are handled in-card so a failure to load
 * prescriptions is visible at the card location, not bumped up to a
 * shell-level error.
 */

import React from 'react';

import { usePrescriptions } from '../fhir/hooks/usePrescriptions';
import type { MedicationRequestDTO } from '../fhir/schemas/medicationRequest';

import { Card } from './Card';
import { openCardEditor } from './cardEditUrls';

const STATUS_ROW = 'text-base py-1 text-ink-muted';

interface PrescriptionsCardProps {
  patientId: string;
  accessToken: string;
  userId?: string | null;
  pid?: string | null;
}

export function PrescriptionsCard({
  patientId,
  accessToken,
  userId = null,
  pid = null,
}: PrescriptionsCardProps): React.JSX.Element {
  const query = usePrescriptions(patientId, accessToken);

  return (
    <Card
      title="Prescriptions"
      cardId="prescriptions"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={() => openCardEditor('prescriptions')}
      data-testid="prescriptions-card"
    >
      <PrescriptionsBody query={query} />
    </Card>
  );
}

interface PrescriptionsBodyProps {
  query: ReturnType<typeof usePrescriptions>;
}

function PrescriptionsBody({
  query,
}: PrescriptionsBodyProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load prescriptions.
      </div>
    );
  }
  const rxs = query.data ?? [];
  if (rxs.length === 0) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  return (
    <ul
      className="list-none m-0 p-0 flex flex-col"
      data-testid="prescriptions-list"
    >
      {rxs.map((m) => (
        <PrescriptionRow key={m.id} prescription={m} />
      ))}
    </ul>
  );
}

interface PrescriptionRowProps {
  prescription: MedicationRequestDTO;
}

function PrescriptionRow({
  prescription,
}: PrescriptionRowProps): React.JSX.Element {
  return (
    <li
      className="py-1 text-base text-ink flex flex-col"
      data-testid="prescription-row"
    >
      <span>{prescription.name}</span>
      {prescription.dosingText !== null && prescription.dosingText.length > 0 ? (
        <span
          className="text-ink-muted text-sm"
          data-testid="prescription-dosing"
        >
          {prescription.dosingText}
        </span>
      ) : null}
    </li>
  );
}
