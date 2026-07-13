/**
 * Medical Problems card — plain-row list of the patient's active conditions.
 *
 * Unlike the Allergies card, rows here carry no severity tint (per W2 PRD,
 * tinted full-row backgrounds are reserved for the safety-critical Allergies
 * card). Loading / error / empty states are handled in-card so a failure to
 * load problems is visible at the card location, not bumped up to a
 * shell-level error.
 */

import React from 'react';

import { useConditions } from '../fhir/hooks/useConditions';
import type { ConditionDTO } from '../fhir/schemas/condition';

import { Card } from './Card';
import { openCardEditor } from './cardEditUrls';

const STATUS_ROW = 'text-base py-1 text-ink-muted';

interface ProblemsCardProps {
  patientId: string;
  accessToken: string;
  userId?: string | null;
  pid?: string | null;
}

export function ProblemsCard({
  patientId,
  accessToken,
  userId = null,
  pid = null,
}: ProblemsCardProps): React.JSX.Element {
  const query = useConditions(patientId, accessToken);

  return (
    <Card
      title="Medical Problems"
      cardId="problems"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={() => openCardEditor('problems')}
      data-testid="problems-card"
    >
      <ProblemsBody query={query} />
    </Card>
  );
}

interface ProblemsBodyProps {
  query: ReturnType<typeof useConditions>;
}

function ProblemsBody({ query }: ProblemsBodyProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load problems.
      </div>
    );
  }
  const problems = query.data ?? [];
  if (problems.length === 0) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  return (
    <ul
      className="list-none m-0 p-0 flex flex-col"
      data-testid="problems-list"
    >
      {problems.map((c) => (
        <ProblemRow key={c.id} condition={c} />
      ))}
    </ul>
  );
}

interface ProblemRowProps {
  condition: ConditionDTO;
}

function ProblemRow({ condition }: ProblemRowProps): React.JSX.Element {
  return (
    <li
      className="py-1 text-base text-ink"
      data-testid="problem-row"
    >
      {condition.name !== '' ? condition.name : '(unnamed condition)'}
    </li>
  );
}
