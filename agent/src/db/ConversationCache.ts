/**
 * ConversationCache — in-memory store of {conversationId → ToolTranscript}
 * with a 30-minute TTL. Lets follow-up turns reuse the pre-visit fan-out
 * instead of re-hitting FHIR.
 *
 * Sized for one process; the agent service runs as a single replica.
 *
 * D11: PHI-bearing — purged after 30 min of inactivity to match the
 * conversations TTL.
 */

import type { ToolResult } from '../tools/types.js';
import type { EncounterDiff } from '../clinical/EncounterDiff.js';

export interface CachedTranscript {
  pid: number;
  patientUuid: string;
  toolResults: ToolResult[];
  diff: EncounterDiff | null;
  /** Pre-visit summary if the conversation started from a previsit pull. */
  previsitSummary: string | null;
  createdAt: number;
  lastTouched: number;
}

export class ConversationCache {
  private store = new Map<string, CachedTranscript>();
  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly clock: () => number = Date.now,
  ) {}

  get(conversationId: string): CachedTranscript | null {
    const entry = this.store.get(conversationId);
    if (!entry) return null;
    if (this.clock() - entry.lastTouched > this.ttlMs) {
      this.store.delete(conversationId);
      return null;
    }
    entry.lastTouched = this.clock();
    return entry;
  }

  set(conversationId: string, value: Omit<CachedTranscript, 'createdAt' | 'lastTouched'>): void {
    const now = this.clock();
    this.store.set(conversationId, {
      ...value,
      createdAt: now,
      lastTouched: now,
    });
  }

  delete(conversationId: string): void {
    this.store.delete(conversationId);
  }

  /** Manual purge — useful from tests and the periodic cleanup job. */
  purgeStale(): number {
    const cutoff = this.clock() - this.ttlMs;
    let removed = 0;
    for (const [id, entry] of this.store) {
      if (entry.lastTouched < cutoff) {
        this.store.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.store.size;
  }
}
