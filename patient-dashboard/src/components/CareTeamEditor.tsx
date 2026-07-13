/**
 * Inline Care Team editor for the SPA dashboard card.
 *
 * Mirrors the legacy `templates/patient/card/manage_care_team.html.twig`
 * row-based table editor, but uses native `<select>` and
 * `<input type="date">` so the SPA stays free of jQuery / select2 /
 * datepicker dependencies.
 *
 * Validation rules — kept aligned with the Twig editor's `required`
 * attributes:
 *   - team_name required
 *   - per row: member, role, since, status required
 * Rows that fail validation are reported in-form and the save mutation is
 * not fired.
 *
 * State model: a parent <CareTeamCard> drives a flag that flips between
 * the read view and this editor. The editor itself owns the in-progress
 * draft (rows array, team_name, team_status). On Save → call the mutation
 * → on success, the parent flips back to read mode and TanStack Query
 * invalidates the `['careTeam', pid]` read so the card refreshes.
 */

import React, { useEffect, useMemo, useState } from 'react';

import {
  useCareTeamForm,
  useSaveCareTeam,
  type CareTeamFormData,
  type CareTeamFormMember,
} from '../fhir/hooks/useCareTeamForm';

interface CareTeamEditorProps {
  patientId: string;
  onCancel: () => void;
  onSaved: () => void;
}

interface DraftRow extends CareTeamFormMember {
  // Per-row stable key for React reconciliation. The persisted shape uses
  // member_id + member_type, but a freshly-added empty row has no such id
  // yet, so we mint a local one here.
  _key: string;
}

let rowKeySeq = 0;
function nextKey(): string {
  rowKeySeq += 1;
  return `row-${String(rowKeySeq)}`;
}

function emptyDraftRow(): DraftRow {
  return {
    _key: nextKey(),
    member_type: 'user',
    member_id: '',
    role: '',
    facility_id: '',
    provider_since: '',
    status: 'active',
    note: '',
    display_name: '',
  };
}

function toDraftRows(members: CareTeamFormMember[]): DraftRow[] {
  return members.map((m) => ({ ...m, _key: nextKey() }));
}

export function CareTeamEditor({
  patientId,
  onCancel,
  onSaved,
}: CareTeamEditorProps): React.JSX.Element {
  const formQuery = useCareTeamForm(patientId, true);
  const saveMutation = useSaveCareTeam(patientId);

  if (formQuery.isLoading) {
    return (
      <div className="text-base py-1 text-ink-muted">Loading editor…</div>
    );
  }
  if (formQuery.isError || formQuery.data === undefined) {
    return (
      <div className="text-base py-1 text-severe">
        Failed to load editor.
        <button
          type="button"
          onClick={onCancel}
          className="ml-2 underline text-ink-muted hover:text-ink"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <CareTeamEditorForm
      patientId={patientId}
      formData={formQuery.data}
      onCancel={onCancel}
      onSaved={onSaved}
      saveMutation={saveMutation}
    />
  );
}

interface CareTeamEditorFormProps {
  patientId: string;
  formData: CareTeamFormData;
  onCancel: () => void;
  onSaved: () => void;
  saveMutation: ReturnType<typeof useSaveCareTeam>;
}

function CareTeamEditorForm({
  patientId,
  formData,
  onCancel,
  onSaved,
  saveMutation,
}: CareTeamEditorFormProps): React.JSX.Element {
  const [teamName, setTeamName] = useState<string>(formData.team_name);
  const [teamStatus, setTeamStatus] = useState<string>(
    formData.team_status === '' ? 'active' : formData.team_status,
  );
  const [rows, setRows] = useState<DraftRow[]>(() =>
    toDraftRows(formData.members),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  // When the upstream form-data refreshes (rare — the form is normally
  // mounted once per edit session) sync the draft so the editor reflects
  // the latest persisted shape. Cleared on user edits below.
  useEffect(() => {
    setTeamName(formData.team_name);
    setTeamStatus(
      formData.team_status === '' ? 'active' : formData.team_status,
    );
    setRows(toDraftRows(formData.members));
  }, [formData]);

  const memberOptions = useMemo(
    () => formData.options.member_users,
    [formData.options.member_users],
  );

  function updateRow(index: number, patch: Partial<DraftRow>): void {
    setRows((prev) => {
      const next = prev.slice();
      const current = next[index];
      if (current === undefined) {
        return prev;
      }
      next[index] = { ...current, ...patch };
      return next;
    });
  }

  function addRow(): void {
    setRows((prev) => prev.concat(emptyDraftRow()));
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSave(): void {
    setValidationError(null);
    if (teamName.trim() === '') {
      setValidationError('Care team name is required.');
      return;
    }
    for (const [i, r] of rows.entries()) {
      const rowNum = i + 1;
      if (r.member_id.trim() === '') {
        setValidationError(`Row ${String(rowNum)}: member is required.`);
        return;
      }
      if (r.role.trim() === '') {
        setValidationError(`Row ${String(rowNum)}: role is required.`);
        return;
      }
      if (r.provider_since.trim() === '') {
        setValidationError(`Row ${String(rowNum)}: since is required.`);
        return;
      }
      if (r.status.trim() === '') {
        setValidationError(`Row ${String(rowNum)}: status is required.`);
        return;
      }
    }

    const team: CareTeamFormMember[] = rows.map((r) => ({
      member_type: r.member_type,
      member_id: r.member_id,
      role: r.role,
      facility_id: r.facility_id,
      provider_since: r.provider_since,
      status: r.status,
      note: r.note,
      display_name: r.display_name,
    }));

    saveMutation.mutate(
      {
        pid: patientId,
        team_id: formData.team_id,
        team_name: teamName.trim(),
        team_status: teamStatus,
        team,
        csrf: formData.csrf,
      },
      {
        onSuccess: () => {
          onSaved();
        },
      },
    );
  }

  const inputBaseClass =
    'w-full text-base bg-bg-card border border-border rounded px-2 py-1 text-ink focus:outline-2 focus:outline-blue';
  const labelClass = 'text-base text-ink-muted block mb-1';

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
      data-testid="care-team-editor"
    >
      <div className="flex gap-3 flex-wrap">
        <div className="flex flex-col">
          <label htmlFor="care-team-name" className={labelClass}>
            Care Team Name
          </label>
          <input
            id="care-team-name"
            type="text"
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            className={inputBaseClass}
            data-testid="care-team-editor-name"
          />
        </div>
        <div className="flex flex-col">
          <label htmlFor="care-team-status" className={labelClass}>
            Care Team Status
          </label>
          <select
            id="care-team-status"
            value={teamStatus}
            onChange={(e) => setTeamStatus(e.target.value)}
            className={inputBaseClass}
            data-testid="care-team-editor-status"
          >
            {formData.options.statuses.map((s) => (
              <option key={s.code} value={s.code}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-base border-collapse">
          <thead>
            <tr className="text-left text-ink-muted">
              <th className="pr-2 py-1 font-medium">Member</th>
              <th className="pr-2 py-1 font-medium">Role</th>
              <th className="pr-2 py-1 font-medium">Facility</th>
              <th className="pr-2 py-1 font-medium">Since</th>
              <th className="pr-2 py-1 font-medium">Status</th>
              <th className="pr-2 py-1 font-medium">Note</th>
              <th className="py-1 font-medium" aria-label="Remove" />
            </tr>
          </thead>
          <tbody data-testid="care-team-editor-rows">
            {rows.map((row, index) => (
              <tr key={row._key} data-testid="care-team-editor-row">
                <td className="pr-2 py-1">
                  <select
                    value={row.member_id}
                    onChange={(e) =>
                      updateRow(index, { member_id: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-member"
                    aria-label={`Member for row ${String(index + 1)}`}
                  >
                    <option value="">— select —</option>
                    {memberOptions.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2 py-1">
                  <select
                    value={row.role}
                    onChange={(e) =>
                      updateRow(index, { role: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-role"
                    aria-label={`Role for row ${String(index + 1)}`}
                  >
                    <option value="">— select —</option>
                    {formData.options.roles.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2 py-1">
                  <select
                    value={row.facility_id}
                    onChange={(e) =>
                      updateRow(index, { facility_id: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-facility"
                    aria-label={`Facility for row ${String(index + 1)}`}
                  >
                    <option value="">— none —</option>
                    {formData.options.facilities.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2 py-1">
                  <input
                    type="date"
                    value={row.provider_since}
                    onChange={(e) =>
                      updateRow(index, { provider_since: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-since"
                    aria-label={`Provider since for row ${String(index + 1)}`}
                  />
                </td>
                <td className="pr-2 py-1">
                  <select
                    value={row.status}
                    onChange={(e) =>
                      updateRow(index, { status: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-row-status"
                    aria-label={`Status for row ${String(index + 1)}`}
                  >
                    {formData.options.statuses.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="pr-2 py-1">
                  <input
                    type="text"
                    value={row.note}
                    onChange={(e) =>
                      updateRow(index, { note: e.target.value })
                    }
                    className={inputBaseClass}
                    data-testid="care-team-editor-note"
                    aria-label={`Note for row ${String(index + 1)}`}
                  />
                </td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    className="text-ink-muted hover:text-severe text-base px-2"
                    data-testid="care-team-editor-remove-row"
                    aria-label={`Remove row ${String(index + 1)}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={addRow}
          className="text-base text-blue hover:underline"
          data-testid="care-team-editor-add-row"
        >
          + Add Team Member
        </button>
      </div>

      {validationError !== null && (
        <div
          className="text-base text-severe"
          data-testid="care-team-editor-validation"
        >
          {validationError}
        </div>
      )}

      {saveMutation.isError && (
        <div
          className="text-base text-severe"
          data-testid="care-team-editor-save-error"
        >
          Failed to save: {saveMutation.error.message}
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          type="submit"
          disabled={saveMutation.isPending}
          className="text-base bg-blue text-white px-3 py-1 rounded disabled:opacity-50"
          data-testid="care-team-editor-save"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saveMutation.isPending}
          className="text-base bg-bg-card border border-border text-ink px-3 py-1 rounded disabled:opacity-50"
          data-testid="care-team-editor-cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
