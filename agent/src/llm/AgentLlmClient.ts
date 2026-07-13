/**
 * AgentLlmClient — thin adapter over @langchain/openai that exposes two
 * methods the agent actually needs:
 *
 *   chat()           — single-shot completion that returns AnswerSchema JSON
 *   chatWithTools()  — tool-calling loop where the LLM picks tools, the
 *                      agent dispatches them, and the loop ends when the
 *                      LLM stops calling tools.
 *
 * The class is mockable for tests via the LlmInvoker interface — the
 * planner only depends on that surface, not on ChatOpenAI directly.
 *
 * Provider: OpenRouter. We use ChatOpenAI (from @langchain/openai) because
 * OpenRouter exposes an OpenAI-compatible API; only the baseURL + key
 * change. The model is selected by AGENTFORGE_MODEL using OpenRouter slugs
 * (e.g. anthropic/claude-haiku-4.5, openai/gpt-4o-mini, google/gemini-2.5-flash).
 */

import type { Tool, ToolContext, ToolResult } from '../tools/types.js';
import { traceGeneration, type GenerationUsage } from '../observability/index.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls: ChatToolCall[];
}

export interface LlmInvoker {
  chat(messages: ChatMessage[]): Promise<ChatResponse>;
  chatWithTools(messages: ChatMessage[], tools: ChatToolSpec[]): Promise<ChatResponse>;
}

interface ChatModelLike {
  invoke(input: unknown, options?: unknown): Promise<{ content: unknown; tool_calls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> }>;
  bindTools?(tools: unknown[]): ChatModelLike;
}

const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-haiku-4.5';

export class AgentLlmClient implements LlmInvoker {
  constructor(
    private readonly client: ChatModelLike,
    private readonly modelName: string,
  ) {}

  static async fromEnv(env: NodeJS.ProcessEnv = process.env, modelOverride?: string): Promise<AgentLlmClient | null> {
    if (!env['OPENROUTER_API_KEY']) {
      console.warn('[agentforge] OPENROUTER_API_KEY is unset; LLM calls will be skipped');
      return null;
    }
    try {
      const mod = await import('@langchain/openai');
      const ChatOpenAI = (mod as { ChatOpenAI: new (cfg: object) => ChatModelLike }).ChatOpenAI;
      const model = modelOverride ?? env['AGENTFORGE_MODEL'] ?? OPENROUTER_DEFAULT_MODEL;
      const baseURL = env['OPENROUTER_BASE_URL'] ?? OPENROUTER_DEFAULT_BASE_URL;
      const defaultHeaders: Record<string, string> = {};
      if (env['OPENROUTER_REFERER']) defaultHeaders['HTTP-Referer'] = env['OPENROUTER_REFERER'];
      if (env['OPENROUTER_APP_TITLE']) defaultHeaders['X-Title'] = env['OPENROUTER_APP_TITLE'];
      const config: Record<string, unknown> = {
        model,
        temperature: 0,
        apiKey: env['OPENROUTER_API_KEY'],
        configuration: {
          baseURL,
          ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
        },
      };
      return new AgentLlmClient(new ChatOpenAI(config), model);
    } catch (err) {
      console.warn('[agentforge] failed to load ChatOpenAI for OpenRouter', { error: stringifyError(err) });
      return null;
    }
  }

  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const langchainMessages = toLangchainMessages(messages);
    return traceGeneration(
      {
        name: 'llm.chat',
        model: this.modelName,
        input: langchainMessages,
      },
      async () => {
        const response = await this.client.invoke(langchainMessages);
        const content = extractContent(response.content);
        const usage = extractUsage(response);
        const observedModel = extractObservedModel(response);
        return {
          result: {
            content,
            toolCalls: [],
          },
          output: {
            content,
          },
          ...(observedModel ? { model: observedModel } : {}),
          ...(usage ? { usage } : {}),
        };
      },
    );
  }

  async chatWithTools(messages: ChatMessage[], tools: ChatToolSpec[]): Promise<ChatResponse> {
    if (typeof this.client.bindTools !== 'function') {
      return this.chat(messages);
    }
    const bound = this.client.bindTools(toOpenAiTools(tools));
    const langchainMessages = toLangchainMessages(messages);
    return traceGeneration(
      {
        name: 'llm.chat_with_tools',
        model: this.modelName,
        input: {
          messages: langchainMessages,
          tools: toOpenAiTools(tools),
        },
      },
      async () => {
        const response = await bound.invoke(langchainMessages);
        const content = extractContent(response.content);
        const toolCalls = (response.tool_calls ?? []).map((tc, i) => ({
          id: tc.id ?? `call_${i}`,
          name: tc.name ?? '',
          args: tc.args ?? {},
        }));
        const usage = extractUsage(response);
        const observedModel = extractObservedModel(response);
        return {
          result: {
            content,
            toolCalls,
          },
          output: {
            content,
            tool_calls: toolCalls,
          },
          ...(observedModel ? { model: observedModel } : {}),
          ...(usage ? { usage } : {}),
        };
      },
    );
  }
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
      .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

function toOpenAiTools(tools: ChatToolSpec[]): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function toLangchainMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(m => {
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.tool_call_id) base['tool_call_id'] = m.tool_call_id;
    if (m.name) base['name'] = m.name;
    if (m.tool_calls) base['tool_calls'] = m.tool_calls;
    return base;
  });
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractUsage(response: unknown): GenerationUsage | undefined {
  const responseRecord = asRecord(response);
  const usageMeta = asRecord(responseRecord?.['usage_metadata']);
  const usageTopLevel = asRecord(responseRecord?.['usage']);
  const responseMeta = asRecord(responseRecord?.['response_metadata']);
  const responseTokenUsage = asRecord(responseMeta?.['tokenUsage'])
    ?? asRecord(responseMeta?.['token_usage'])
    ?? asRecord(responseMeta?.['usage'])
    ?? asRecord(responseMeta?.['usage_metadata']);

  const promptTokens = firstNumber(
    usageMeta?.['input_tokens'],
    usageTopLevel?.['input_tokens'],
    usageTopLevel?.['prompt_tokens'],
    usageTopLevel?.['promptTokens'],
    responseTokenUsage?.['promptTokens'],
    responseTokenUsage?.['prompt_tokens'],
    responseTokenUsage?.['input_tokens'],
    responseTokenUsage?.['inputTokens'],
  );
  const completionTokens = firstNumber(
    usageMeta?.['output_tokens'],
    usageTopLevel?.['output_tokens'],
    usageTopLevel?.['completion_tokens'],
    usageTopLevel?.['completionTokens'],
    responseTokenUsage?.['completionTokens'],
    responseTokenUsage?.['completion_tokens'],
    responseTokenUsage?.['output_tokens'],
    responseTokenUsage?.['outputTokens'],
  );
  const totalTokens = firstNumber(
    usageMeta?.['total_tokens'],
    usageTopLevel?.['total_tokens'],
    usageTopLevel?.['totalTokens'],
    responseTokenUsage?.['totalTokens'],
    responseTokenUsage?.['total_tokens'],
    responseTokenUsage?.['total_tokens'],
    promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined,
  );

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function extractObservedModel(response: unknown): string | undefined {
  const responseRecord = asRecord(response);
  const responseMeta = asRecord(responseRecord?.['response_metadata']);
  const model = responseMeta?.['model_name'] ?? responseMeta?.['model'];
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * runToolCallLoop — repeatedly invokes the LLM with bound tools, dispatches
 * each tool call, appends the result, and stops when the LLM returns no
 * tool_calls. A hard cap of 4 iterations prevents runaway loops.
 */
export async function runToolCallLoop(
  llm: LlmInvoker,
  toolSpecs: ChatToolSpec[],
  toolImpls: Record<string, Tool>,
  context: ToolContext,
  initialMessages: ChatMessage[],
  maxIterations = 4,
): Promise<{ messages: ChatMessage[]; toolResults: ToolResult[] }> {
  const messages = [...initialMessages];
  const toolResults: ToolResult[] = [];

  for (let i = 0; i < maxIterations; i++) {
    const response = await llm.chatWithTools(messages, toolSpecs);
    if (response.toolCalls.length === 0) {
      messages.push({ role: 'assistant', content: response.content });
      return { messages, toolResults };
    }

    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls,
    });

    for (const call of response.toolCalls) {
      const impl = toolImpls[call.name];
      if (!impl) {
        const errResult: ToolResult = { ok: false, reason: `unknown_tool:${call.name}`, tool: call.name };
        toolResults.push(errResult);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(errResult),
        });
        continue;
      }
      try {
        const result = await impl.execute(call.args, context);
        toolResults.push(result);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const errResult: ToolResult = {
          ok: false,
          reason: err instanceof Error ? err.message : 'tool_threw',
          tool: call.name,
        };
        toolResults.push(errResult);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(errResult),
        });
      }
    }
  }

  // Ran out of iterations — ask one last time for a text-only answer.
  const final = await llm.chat([
    ...messages,
    { role: 'system', content: 'Tool budget exhausted. Reply with the final AnswerSchema JSON now, no more tool calls.' },
  ]);
  messages.push({ role: 'assistant', content: final.content });
  return { messages, toolResults };
}
