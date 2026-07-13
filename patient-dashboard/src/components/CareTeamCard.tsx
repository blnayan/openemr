/**
 * Care Team card.
 *
 * Read view renders the legacy demographics.php Care Team layout:
 *
 *   - Header line with team name + a green status pill ("Active")
 *   - Multi-column table: Type | Member | Role | Facility | Since |
 *     Status | Note
 *
 * Backed by the same `form-data.php` endpoint the editor uses (rather
 * than the FHIR `CareTeam` resource) because that endpoint already
 * resolves codes → labels server-side and returns the team-level
 * metadata (team_name, team_status) the FHIR shape doesn't carry.
 *
 * Loading / error / empty states are handled in-card so a failure to
 * load the care team is visible at the card location, not bumped up
 * to a shell-level error.
 *
 * The pencil affordance flips the card body into a native React editor
 * (`<CareTeamEditor>`) backed by two same-origin JSON endpoints —
 * `interface/patient_file/summary/dashboard/care-team/{form-data,save}.php`
 * — that wrap `CareTeamService::saveCareTeam`. Save success invalidates
 * the read query and the card flips back to the read view.
 */

import React, { useCallback, useMemo, useState } from 'react';

import {
  useCareTeamForm,
  type CareTeamFormData,
  type CareTeamFormMember,
} from '../fhir/hooks/useCareTeamForm';

import { Card } from './Card';
import { CareTeamEditor } from './CareTeamEditor';

const STATUS_ROW = 'text-base py-1 text-ink-muted';

interface CareTeamCardProps {
  patientId: string;
  // Kept for prop-shape parity with sibling cards even though this card
  // doesn't make FHIR calls — both the read and write paths go through
  // session-cookie endpoints that derive credentials from the OpenEMR
  // session, not the OAuth bearer.
  accessToken: string;
  userId?: string | null;
  pid?: string | null;
}

export function CareTeamCard({
  patientId,
  userId = null,
  pid = null,
}: CareTeamCardProps): React.JSX.Element {
  const formQuery = useCareTeamForm(patientId, true);
  const [editing, setEditing] = useState(false);

  const onEdit = useCallback(() => {
    setEditing(true);
  }, []);
  const onCancel = useCallback(() => {
    setEditing(false);
  }, []);
  const onSaved = useCallback(() => {
    setEditing(false);
  }, []);

  return (
    <Card
      title="Care Team"
      cardId="careTeam"
      userId={userId}
      pid={pid ?? patientId}
      onEdit={onEdit}
      data-testid="care-team-card"
    >
      {editing ? (
        <CareTeamEditor
          patientId={patientId}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      ) : (
        <CareTeamReadView query={formQuery} />
      )}
    </Card>
  );
}

interface CareTeamReadViewProps {
  query: ReturnType<typeof useCareTeamForm>;
}

function CareTeamReadView({ query }: CareTeamReadViewProps): React.JSX.Element {
  if (query.isLoading) {
    return <div className={STATUS_ROW}>Loading…</div>;
  }
  if (query.isError) {
    return (
      <div className={`${STATUS_ROW} text-severe`}>
        Failed to load care team.
      </div>
    );
  }
  const data = query.data;
  if (data === undefined) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  if (data.members.length === 0) {
    return <div className={STATUS_ROW}>Nothing Recorded</div>;
  }
  return <CareTeamTable data={data} />;
}

const TYPE_LABEL: Record<CareTeamFormMember['member_type'], string> = {
  user: 'Provider',
  contact: 'Contact',
};

/**
 * Per-status chip color. Active is the safety-positive green; inactive /
 * completed read as neutral; suspended is amber; data-quality errors are
 * red. Unknown codes fall back to neutral so an unfamiliar status still
 * renders without crashing the row.
 */
function statusChipClass(code: string): string {
  switch (code) {
    case 'active':
      return 'bg-ok text-white';
    case 'suspended':
      return 'bg-warn-bg text-warn';
    case 'entered-in-error':
      return 'bg-severe-bg text-severe';
    case 'inactive':
    case 'completed':
    default:
      return 'bg-bg-control-hover text-ink-muted';
  }
}

interface CareTeamTableProps {
  data: CareTeamFormData;
}

function CareTeamTable({ data }: CareTeamTableProps): React.JSX.Element {
  // Build label dictionaries up-front so the row mapper resolves codes
  // → display strings without doing N×M scans.
  const roleLabel = useMemo(
    () => buildLabelMap(data.options.roles, 'code'),
    [data.options.roles],
  );
  const facilityLabel = useMemo(
    () => buildLabelMap(data.options.facilities, 'id'),
    [data.options.facilities],
  );
  const statusLabel = useMemo(
    () => buildLabelMap(data.options.statuses, 'code'),
    [data.options.statuses],
  );

  return (
    <div data-testid="care-team-table">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-base text-ink font-medium">{data.team_name}</span>
        {data.team_status === 'active' && (
          <span className="bg-ok text-white text-xs font-semibold px-2 py-0.5 rounded-3 uppercase tracking-label">
            Active
          </span>
        )}
        {data.team_status !== 'active' && data.team_status !== '' && (
          <span className="bg-bg-control-hover text-ink-muted text-xs font-semibold px-2 py-0.5 rounded-3 uppercase tracking-label">
            {statusLabel.get(data.team_status) ?? data.team_status}
          </span>
        )}
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-xs uppercase tracking-label text-ink-muted bg-bg-page">
            <th className="font-semibold py-1.5 px-2">Type</th>
            <th className="font-semibold py-1.5 px-2">Member</th>
            <th className="font-semibold py-1.5 px-2">Role</th>
            <th className="font-semibold py-1.5 px-2">Facility</th>
            <th className="font-semibold py-1.5 px-2">Since</th>
            <th className="font-semibold py-1.5 px-2">Status</th>
            <th className="font-semibold py-1.5 px-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {data.members.map((m, idx) => (
            <tr
              key={`${m.member_type}-${m.member_id}-${idx}`}
              className="border-t border-border-soft text-base text-ink"
              data-testid="care-team-row"
            >
              <td className="py-1.5 px-2">
                <span className="bg-blue-soft text-blue text-xs font-semibold px-2 py-0.5 rounded-3">
                  {TYPE_LABEL[m.member_type]}
                </span>
              </td>
              <td className="py-1.5 px-2">{m.display_name}</td>
              <td className="py-1.5 px-2">
                {roleLabel.get(m.role) ?? m.role}
              </td>
              <td className="py-1.5 px-2">
                {m.facility_id !== '' ? facilityLabel.get(m.facility_id) ?? '' : ''}
              </td>
              <td className="py-1.5 px-2">{m.provider_since}</td>
              <td className="py-1.5 px-2">
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded-3 uppercase tracking-label ${statusChipClass(m.status)}`}
                  data-testid="care-team-row-status"
                >
                  {statusLabel.get(m.status) ?? m.status}
                </span>
              </td>
              <td className="py-1.5 px-2 text-ink-muted">{m.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface KeyedOption {
  label: string;
}

/**
 * Build a Map from a list of `{ <key>, label }` rows. Used to resolve
 * stored codes/ids into the human-readable strings the table renders.
 */
function buildLabelMap<K extends string>(
  rows: Array<KeyedOption & Record<K, string>>,
  keyField: K,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row[keyField], row.label);
  }
  return map;
}
