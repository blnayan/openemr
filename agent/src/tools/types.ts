/**
 * Tool envelope contract — every tool returns either a typed-row success
 * or a reason-bearing failure. Patient identity always comes from
 * ToolContext (sourced from the JWT), never from tool params.
 */

import type { FhirClient } from '../fhir/FhirClient.js';

export interface ToolRow {
  id: string;
  [field: string]: unknown;
}

/**
 * Source attribution for a single chart row. When a tool decorates rows
 * with a `source` field of this shape, the chat-layer citation renderer
 * suffixes the claim with "(from <document_name>)" or "(chart entry)"
 * so the doctor can tell at a glance whether a fact came from an
 * uploaded PDF or was entered through the dashboard.
 */
export type SourceAttribution =
  | { kind: 'document'; document_id: number; document_name: string | null; document_date: string | null }
  | { kind: 'chart' };

/**
 * Resolves chart-row UUIDs to their source uploaded document, when any.
 * Implemented by an HTTP client against
 * /interface/agentforge/sidecar.php?action=resource_origins; tools call
 * it after their FHIR query to enrich rows with a `source` attribution
 * field. A null return for a UUID means "this row has no AgentForge
 * source — it's a regular chart entry."
 */
export interface ResourceOriginLookup {
  lookup(
    refs: ReadonlyArray<{
      readonly resourceType: 'procedure_result' | 'lists' | 'pnotes';
      readonly uuid: string;
    }>,
  ): Promise<ReadonlyMap<string, { document_id: number; document_name: string | null; document_date: string | null } | null>>;
}

export type ToolResult<T extends ToolRow = ToolRow> =
  | { ok: true; rows: T[]; tool: string; degraded?: boolean; degradation_reason?: string }
  | { ok: false; reason: string; tool: string };

export interface ToolContext {
  patientUuid: string;
  pid: number;
  jwt: string;
  fhirClient: FhirClient;
  /**
   * Optional. When present, tools that surface chart rows (labs,
   * allergies, medications, etc.) decorate each row with a `source`
   * attribution. When absent or when the lookup fails, rows are
   * returned without `source` — readers should treat the absence as
   * "unknown origin" rather than asserting "chart entry."
   */
  originLookup?: ResourceOriginLookup;
}

export interface ToolCallSpec {
  toolName: string;
  params: Record<string, unknown>;
}

export type ToolFunction = (
  params: Record<string, unknown>,
  context: ToolContext,
) => Promise<ToolResult>;

/** Bound tool — declarative shape with a JSON schema for native LLM tool calling. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: ToolFunction;
}

export function fhirErrorToReason(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status === 404) return 'fhir_404_not_found';
    if (status === 401 || status === 403) return 'fhir_unauthorized';
    if (status >= 500) return 'fhir_server_error';
    return `fhir_${status}`;
  }
  if (err instanceof Error && err.name === 'AbortError') return 'fhir_timeout';
  return 'fhir_unknown_error';
}
