/**
 * TanStack Query hooks for the Care Team in-card editor.
 *
 * `useCareTeamForm` fetches the option set + persisted team shape from the
 * same-origin form-data endpoint at
 *   /interface/patient_file/summary/care-team/form-data.php
 * The bundle includes a freshly-issued CSRF token consumed by the save call.
 *
 * `useSaveCareTeam` POSTs the editor's draft to the matching `save.php`
 * endpoint. On success we invalidate the read query (`['careTeam', pid]`)
 * so the read-mode card on the same page re-fetches and reflects the new
 * state immediately.
 *
 * The endpoints live under the dashboard PHP entry directory so they share
 * the SPA's session cookie — no separate auth handoff is needed. The fetch
 * uses `credentials: 'same-origin'` to be explicit about that.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

const FORM_DATA_URL =
  '/interface/patient_file/summary/care-team/form-data.php';
const SAVE_URL = '/interface/patient_file/summary/care-team/save.php';

export interface CareTeamMemberOption {
  id: string;
  label: string;
}

export interface CareTeamRoleOption {
  code: string;
  label: string;
}

export interface CareTeamStatusOption {
  code: string;
  label: string;
}

export interface CareTeamFormOptions {
  member_users: CareTeamMemberOption[];
  member_practitioners: CareTeamMemberOption[];
  roles: CareTeamRoleOption[];
  facilities: CareTeamMemberOption[];
  statuses: CareTeamStatusOption[];
}

export interface CareTeamFormMember {
  member_type: 'user' | 'contact';
  member_id: string;
  role: string;
  facility_id: string;
  provider_since: string;
  status: string;
  note: string;
  display_name: string;
}

export interface CareTeamFormData {
  team_id: number | null;
  team_name: string;
  team_status: string;
  members: CareTeamFormMember[];
  options: CareTeamFormOptions;
  csrf: string;
}

interface FormDataResponse extends CareTeamFormData {
  ok: boolean;
  error?: string;
}

export interface CareTeamSavePayload {
  pid: string;
  team_id: number | null;
  team_name: string;
  team_status: string;
  team: CareTeamFormMember[];
  csrf: string;
}

interface SaveResponse {
  ok: boolean;
  error?: string;
}

export function useCareTeamForm(
  patientId: string | null,
  enabled: boolean,
): UseQueryResult<CareTeamFormData, Error> {
  return useQuery<CareTeamFormData, Error>({
    queryKey: ['careTeamForm', patientId],
    queryFn: async () => fetchCareTeamFormData(),
    // The form-data endpoint reads the active session's pid; we keep
    // patientId in the key so a patient swap re-fetches.
    enabled: enabled && patientId !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

export async function fetchCareTeamFormData(): Promise<CareTeamFormData> {
  const response = await fetch(FORM_DATA_URL, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`form-data ${response.status}`);
  }
  const body = (await response.json()) as FormDataResponse;
  if (body.ok !== true) {
    throw new Error(body.error ?? 'form-data error');
  }
  return {
    team_id: body.team_id,
    team_name: body.team_name,
    team_status: body.team_status,
    members: body.members,
    options: body.options,
    csrf: body.csrf,
  };
}

export function useSaveCareTeam(
  patientId: string | null,
): UseMutationResult<void, Error, CareTeamSavePayload> {
  const queryClient = useQueryClient();

  return useMutation<void, Error, CareTeamSavePayload>({
    mutationFn: async (payload: CareTeamSavePayload) => {
      // OpenEMR rotates `csrf_private_key` on certain page loads (e.g.
      // main_screen.php). The token we got at form-data fetch time may
      // be stale by the time the user clicks Save. Refetch the CSRF
      // here so we always submit a token derived from the *current*
      // session key. Cheap — the form-data endpoint also returns the
      // option lists but we only consume the csrf field.
      const fresh = await fetchCareTeamFormData();
      const response = await fetch(SAVE_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ ...payload, csrf: fresh.csrf }),
      });
      let body: SaveResponse | null = null;
      try {
        body = (await response.json()) as SaveResponse;
      } catch {
        body = null;
      }
      if (!response.ok || body?.ok !== true) {
        const message = body?.error ?? `save ${response.status}`;
        throw new Error(message);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['careTeam', patientId],
      });
      await queryClient.invalidateQueries({
        queryKey: ['careTeamForm', patientId],
      });
    },
  });
}
