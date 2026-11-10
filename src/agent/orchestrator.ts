// One turn of the agent, end to end:
//
//   persist user message ─► recall memory + resolve dates (deterministic, ~ms)
//     ─► model step (streamed) ─┬─► answer text ─► done
//                               └─► web_search calls (parallel) ─► next step (≤ maxSearchSteps)
//     ─► persist answer + turn ─► [background] memory notes (title, summary, claims)
//                               ─► [optional] citation check with upheld
//
// The model only ever sees one tool. Memory is context, not a tool: it is retrieved before
// the first token, so recalling "last Tuesday" costs no extra model round trip.
import { config } from '../config.js';
import { type Message, streamChat, type ToolCall, type Usage } from '../llm/deepseek.js';
import { recall } from '../memory/recall.js';
import type { MemoryStore } from '../memory/store.js';
import { safeTz } from '../memory/temporal.js';
import { processTurn } from '../memory/writer.js';
import { DeepSeekSearch, formatResultsForModel, SourceRegistry, webSearch } from '../search/index.js';
import type { AgentEvent, SearchProvider, SearchQuery, Source, SourceSummary, TurnInput, TurnMemory, TurnTrace } from '../types.js';
import { upheldEnabled, verifyAnswer } from '../verify/upheld.js';
import { citedNumbers, dropUnknownCitations } from './citations.js';
import { contextMessage, historyMessages } from './context.js';
import { ANSWER_NOW, SYSTEM_PROMPT, WEB_SEARCH_TOOL } from './prompts.js';

export interface AgentDeps {
  /** This user's memory. Node passes a SQLite file; the hosted Worker, the visitor's Durable Object. */
  store: MemoryStore;
  provider?: SearchProvider;
}

export interface TurnResult {
  conversationId: string;
  messageId: string;
  content: string;
  trace: TurnTrace;
  /** Settles when the background memory notes for this turn are written. */
  notes: Promise<unknown>;
}

let defaultProvider: SearchProvider | undefined;
const getProvider = (): SearchProvider => (defaultProvider ??= new DeepSeekSearch());

// Background work (memory notes) is tracked so scripts and evals can wait for it.
const pending = new Set<Promise<unknown>>();
function track(p: Promise<unknown>): void {
  pending.add(p);
  void p.finally(() => pending.delete(p));
}
export async function flushBackground(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}

const summarize = (s: Source): SourceSummary => ({ n: s.n, url: s.url, title: s.title, site: s.site, published: s.published });

export async function runTurn(input: TurnInput, emit: (e: AgentEvent) => void, deps: AgentDeps): Promise<TurnResult> {
  const store = deps.store;
  const provider = deps.provider ?? getProvider();
  const clock = { now: input.clock.now, tz: safeTz(input.clock.tz) };
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);

  // ── conversation + user message ──
  let conversation = input.conversationId ? store.getConversation(input.conversationId) : null;
  const isNew = !conversation;
  conversation ??= store.createConversation(clock.now);
  const conversationId = conversation.id;
  const prior = isNew ? [] : store.getMessages(conversationId);
  const userMsg = store.addMessage({ conversationId, role: 'user', content: input.message, createdAt: clock.now });
  // A provisional title so the sidebar shows something now; the memory writer replaces it.
  if (!conversation.title) store.setTitle(conversationId, provisionalTitle(input.message));
  emit({ type: 'start', conversationId, userMessageId: userMsg.id });

  // ── memory: resolve dates, retrieve past exchanges ──
  const memory = recall(store, input.message, clock, { conversationId });
  if (memory.hits.length || memory.refs.length) {
    emit({
      type: 'memory',
      hits: memory.hits.map((h) => ({ askedAt: h.askedAt, question: h.question, conversationTitle: h.conversationTitle })),
      refs: memory.refs,
      emptyRefs: memory.emptyRefs,
    });
  }

  const registry = new SourceRegistry(store.getSources(conversationId));
  const history = historyMessages(prior);
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.messages,
    { role: 'system', content: contextMessage({ clock, memory, conversationSources: registry.all(), inHistory: history.ids }) },
    { role: 'user', content: input.message },
  ];

  // ── the loop: stream a step; if it calls web_search, run the searches and go again ──
  const trace: TurnTrace = {
    model: config.chatModel,
    steps: [],
    timings: { recallMs: Math.round(memory.ms), firstTokenMs: null, searchMs: 0, totalMs: 0 },
    usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
    recall: { hits: memory.hits.length, refs: memory.refs.map((r) => `${r.text} = ${r.label}`), emptyRefs: memory.emptyRefs.map((r) => r.label) },
  };
  let content = '';

  try {
    for (let step = 0; ; step++) {
      const canSearch = step < config.maxSearchSteps;
      if (!canSearch) messages.push({ role: 'system', content: ANSWER_NOW });

      let stepFirstToken: number | null = null;
      let result: { content: string; toolCalls: ToolCall[]; usage: Usage } | undefined;
      for await (const piece of streamChat({ messages, tools: [WEB_SEARCH_TOOL], toolChoice: canSearch ? 'auto' : 'none', signal: input.signal })) {
        if (piece.type === 'content') {
          stepFirstToken ??= elapsed();
          content += piece.text;
          emit({ type: 'token', step, text: piece.text });
        } else {
          result = piece;
        }
      }
      if (!result) throw new Error('model stream ended without a result');
      addUsage(trace.usage, result.usage);

      if (!canSearch || result.toolCalls.length === 0) {
        content = result.content;
        trace.timings.firstTokenMs = stepFirstToken;
        break;
      }

      // Text written before a tool call is a preamble, not the answer.
      content = '';
      messages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
      });

      const s0 = performance.now();
      const outputs = await Promise.all(
        result.toolCalls.map(async (tc) => {
          const queries = parseQueries(tc);
          if (!queries) return { tc, text: 'Invalid arguments. Call web_search with {"queries": [{"q": "..."}]}.' };
          emit({ type: 'search', step, queries });
          const outcome = await webSearch(queries, { question: input.message, registry, provider, signal: input.signal });
          emit({ type: 'sources', step, sources: outcome.sources.map(summarize) });
          trace.steps.push({ queries, ms: Math.round(outcome.ms), sources: outcome.sources.length });
          return { tc, text: formatResultsForModel(outcome) };
        }),
      );
      trace.timings.searchMs += Math.round(performance.now() - s0);
      for (const o of outputs) messages.push({ role: 'tool', tool_call_id: o.tc.id, content: o.text });
    }
  } catch (err) {
    if (input.signal?.aborted) {
      // The user pressed Stop: keep what they saw, so history matches their screen.
      if (content.trim()) persistAnswer(`${content.trim()}\n\n*(stopped)*`);
      throw err;
    }
    emit({ type: 'error', message: friendlyError(err) });
    throw err;
  }

  // ── finish: keep only real citations, persist, notify ──
  const known = new Set(registry.all().map((s) => s.n));
  content = dropUnknownCitations(content, known).trim();
  const { messageId, cited } = persistAnswer(content);
  store.saveSources(conversationId, registry.all());

  emit({ type: 'done', messageId, content, sources: cited.map(summarize), trace });

  // ── after the answer: memory notes in the background, citation check in-stream ──
  const turn: TurnMemory = {
    messageId,
    conversationId,
    askedAt: userMsg.createdAt,
    question: input.message,
    answer: content,
    summary: null,
    topics: [],
    entities: [],
    claims: [],
    sources: cited.map(summarize),
  };
  store.saveTurn(turn);
  const notes = processTurn(store, turn, isNew || !conversation.title);
  track(notes);

  if (upheldEnabled() && cited.length) {
    const verification = await verifyAnswer({ question: input.message, answer: content, sources: cited }, { signal: input.signal });
    store.setVerification(messageId, verification);
    emit({ type: 'verification', messageId, verification });
  }

  return { conversationId, messageId, content, trace, notes };

  function persistAnswer(text: string): { messageId: string; cited: Source[] } {
    trace.timings.totalMs = elapsed();
    const cited = citedNumbers(text)
      .map((n) => registry.get(n))
      .filter((s): s is Source => Boolean(s));
    const msg = store.addMessage({
      conversationId,
      role: 'assistant',
      content: text,
      createdAt: new Date(clock.now.getTime() + Math.max(1, elapsed())),
      sources: cited.map(summarize),
      trace,
    });
    return { messageId: msg.id, cited };
  }
}

function parseQueries(tc: ToolCall): SearchQuery[] | null {
  if (tc.name !== 'web_search') return null;
  try {
    const args = JSON.parse(tc.arguments || '{}') as { queries?: unknown };
    const list = Array.isArray(args.queries) ? args.queries : [];
    const queries = list
      .map((q): SearchQuery | null => {
        if (typeof q === 'string') return { q };
        if (q && typeof q === 'object' && typeof (q as SearchQuery).q === 'string') {
          const { q: text, site, after } = q as SearchQuery;
          return { q: text, ...(site ? { site } : {}), ...(after ? { after } : {}) };
        }
        return null;
      })
      .filter((q): q is SearchQuery => Boolean(q?.q.trim()));
    return queries.length ? queries.slice(0, 8) : null;
  } catch {
    return null;
  }
}

function addUsage(total: TurnTrace['usage'], u: Usage): void {
  total.promptTokens += u.promptTokens;
  total.completionTokens += u.completionTokens;
  total.cachedTokens += u.cachedTokens;
}

function provisionalTitle(message: string): string {
  const t = message.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t;
}

function friendlyError(err: unknown): string {
  const status = (err as { status?: number })?.status;
  if (status === 401) return 'The DeepSeek API key was rejected. Check DEEPSEEK_API_KEY in .env.';
  if (status === 402) return 'The DeepSeek account is out of balance.';
  if (status === 429) return 'DeepSeek is rate-limiting requests. Try again in a moment.';
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}
