// DeepSeek through its OpenAI-compatible Chat Completions API.
// One client per process, created on first use: keep-alive connections cut a TLS handshake
// off every call, and waiting until then lets the hosted Worker set the key first.
import OpenAI from 'openai';
import type { ChatCompletionChunk, ChatCompletionCreateParamsStreaming, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { config } from '../config.js';

export type Message = ChatCompletionMessageParam;
export type Tool = ChatCompletionTool;

let openai: OpenAI | undefined;
const client = (): OpenAI =>
  (openai ??= new OpenAI({
    apiKey: config.deepseekApiKey || 'missing',
    baseURL: config.deepseekBaseUrl,
    maxRetries: 2,
    timeout: 60_000,
  }));

/** DeepSeek defaults to thinking mode at high effort; background jobs always turn it off. */
const NO_THINKING = { thinking: { type: 'disabled' } } as const;

/**
 * Thinking effort for one chat step. With `low`, the model sizes its own thinking: under 100
 * reasoning tokens on an easy question, up to about 2,000 on a hard one. In the evals nothing
 * needed `high`, so it isn't offered.
 */
export type Effort = 'off' | 'low';

const thinking = (effort: Effort) => (effort === 'off' ? NO_THINKING : { thinking: { type: 'enabled' }, reasoning_effort: effort });

/** Reasoning tokens count against max_tokens, so a thinking step gets room for them on top of the answer. */
const THINKING_ROOM: Record<Effort, number> = { off: 0, low: 8_192 };

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type StreamPiece =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'done'; content: string; reasoning: string; toolCalls: ToolCall[]; finishReason: string | null; usage: Usage };

export interface Usage {
  promptTokens: number;
  /** Includes reasoning tokens. */
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/**
 * Stream one model step. Yields content as it arrives and, at the end, the assembled
 * tool calls (DeepSeek streams their arguments in fragments keyed by index).
 */
export async function* streamChat(params: {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  model?: string;
  effort?: Effort;
  signal?: AbortSignal;
}): AsyncGenerator<StreamPiece> {
  const effort = params.effort ?? 'off';
  const body = {
    model: params.model ?? config.chatModel,
    messages: params.messages,
    tools: params.tools?.length ? params.tools : undefined,
    tool_choice: params.tools?.length ? (params.toolChoice ?? 'auto') : undefined,
    temperature: params.temperature ?? 0.4,
    max_tokens: (params.maxTokens ?? 4096) + THINKING_ROOM[effort],
    stream: true,
    stream_options: { include_usage: true },
    ...thinking(effort),
  } as ChatCompletionCreateParamsStreaming;

  const stream = await client().chat.completions.create(body, { signal: params.signal });

  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const calls = new Map<number, ToolCall>();
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0 };

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as (ChatCompletionChunk.Choice.Delta & { reasoning_content?: string | null }) | undefined;
    if (delta?.reasoning_content) {
      reasoning += delta.reasoning_content;
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    if (delta?.content) {
      content += delta.content;
      yield { type: 'content', text: delta.content };
    }
    for (const tc of delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      const u = chunk.usage as typeof chunk.usage & { prompt_cache_hit_tokens?: number };
      usage.promptTokens = u.prompt_tokens ?? 0;
      usage.completionTokens = u.completion_tokens ?? 0;
      usage.cachedTokens = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      usage.reasoningTokens = u.completion_tokens_details?.reasoning_tokens ?? 0;
    }
  }

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.name);
  yield { type: 'done', content, reasoning, toolCalls, finishReason, usage };
}

/**
 * One non-streaming call in JSON mode, for background jobs (memory writing, eval judging).
 * The system prompt must mention JSON (a DeepSeek requirement for json_object mode).
 */
export async function chatJSON<T>(system: string, user: string, opts: { model?: string; maxTokens?: number; signal?: AbortSignal } = {}): Promise<T> {
  const res = await client().chat.completions.create(
    {
      model: opts.model ?? config.memoryModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: opts.maxTokens ?? 2048,
      stream: false,
      ...NO_THINKING,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    { signal: opts.signal },
  );
  const text = res.choices[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('empty JSON response');
  return JSON.parse(text) as T;
}
