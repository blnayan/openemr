/**
 * ConversationRepository — in-memory conversation history. PHI is purged
 * after 30 minutes of inactivity (§3.6). The interface stays abstract so a
 * persistent backend can be plugged in later without touching callers.
 */

import type { ConversationMessage } from '../graph/state.js';
import { randomUUID } from 'node:crypto';

export interface ConversationRepository {
  create(opts: { userId: string; encounterId: number | null; pid: number }): Promise<string>;
  /**
   * Returns the messages for a conversation iff (userId, pid) match the
   * conversation's owner. Cross-patient access — same user, different pid —
   * yields an empty array. Callers MUST pass the pid bound to the JWT, not
   * a client-supplied value, so the server enforces patient context
   * regardless of what the browser sends.
   */
  load(conversationId: string, userId: string, pid: number): Promise<ConversationMessage[]>;
  /**
   * Whether the conversation exists AND is owned by (userId, pid). Used by
   * the chat route to decide whether a client-supplied conversation_id can
   * be honored or must be replaced with a fresh one (e.g. after the agent
   * process restarts and the in-memory store is empty, but the browser
   * still has the old id in sessionStorage).
   */
  exists(conversationId: string, userId: string, pid: number): Promise<boolean>;
  appendMessage(conversationId: string, role: 'user' | 'assistant', content: string, payload?: unknown): Promise<string>;
  logToolCall(messageId: string, toolName: string, inputJson: object, outputSummary: object, latencyMs: number): Promise<void>;
  touch(conversationId: string): Promise<void>;
  purgeStale(thresholdMinutes: number): Promise<number>;
}

interface InMemoryConversation {
  id: string;
  userId: string;
  encounterId: number | null;
  pid: number;
  lastActive: number;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: Date;
    payload?: unknown;
  }>;
}

export class InMemoryConversationRepository implements ConversationRepository {
  private store = new Map<string, InMemoryConversation>();

  async create(opts: { userId: string; encounterId: number | null; pid: number }): Promise<string> {
    const id = randomUUID();
    this.store.set(id, {
      id,
      userId: opts.userId,
      encounterId: opts.encounterId,
      pid: opts.pid,
      lastActive: Date.now(),
      messages: [],
    });
    return id;
  }

  async exists(conversationId: string, userId: string, pid: number): Promise<boolean> {
    const conv = this.store.get(conversationId);
    if (!conv) return false;
    return conv.userId === userId && conv.pid === pid;
  }

  async load(conversationId: string, userId: string, pid: number): Promise<ConversationMessage[]> {
    const conv = this.store.get(conversationId);
    if (!conv) return [];
    // Patient-context binding: a conversation belongs to one (userId, pid)
    // pair. Different pid → return empty even for the same user, so a
    // doctor cannot replay patient X's transcript while patient Y is on
    // screen via a leaked / guessed cid.
    if (conv.userId !== userId || conv.pid !== pid) return [];
    return conv.messages.slice(-20).map(m => ({
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      ...(m.payload !== undefined ? { payload: m.payload } : {}),
    }));
  }

  async appendMessage(conversationId: string, role: 'user' | 'assistant', content: string, payload?: unknown): Promise<string> {
    const conv = this.store.get(conversationId);
    if (!conv) throw new Error('conversation_not_found');
    const id = randomUUID();
    conv.messages.push({
      id,
      role,
      content,
      createdAt: new Date(),
      ...(payload !== undefined ? { payload } : {}),
    });
    conv.lastActive = Date.now();
    return id;
  }

  async logToolCall(): Promise<void> {
    // No-op for in-memory mode.
  }

  async touch(conversationId: string): Promise<void> {
    const conv = this.store.get(conversationId);
    if (conv) conv.lastActive = Date.now();
  }

  async purgeStale(thresholdMinutes: number): Promise<number> {
    const cutoff = Date.now() - thresholdMinutes * 60_000;
    let removed = 0;
    for (const [id, conv] of this.store.entries()) {
      if (conv.lastActive < cutoff) {
        this.store.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
