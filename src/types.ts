// Shared contracts between modules. This file is the single source of truth for the
// shapes that cross module boundaries: search <-> agent, memory <-> agent, agent <-> UI.
// All timestamps are ISO-8601 strings in UTC. Timezone-aware rendering happens at the edges.

/** "Now", as the user experiences it. Every date computation takes one of these. */
export interface Clock {
  now: Date;
  /** IANA timezone of the user, e.g. "Europe/London". */
  tz: string;
}

// ───────────────────────────── Search ─────────────────────────────

/** One query the model asks for. `after` and `site` become provider operators. */
export interface SearchQuery {
  q: string;
  /** Only pages published on/after this date (YYYY-MM-DD). */
  after?: string;
  /** Restrict to one domain, e.g. "hubspot.com". */
  site?: string;
}

/** A hit as the provider returned it, before merging and ranking. */
export interface RawResult {
  url: string;
  title: string;
  snippet: string;
  /** Longer model-oriented summary (DeepSeek returns ~600-800 chars). */
  summary: string;
  /** Full page text when available, else "". */
  content: string;
  siteName?: string;
  /** ISO publication date when known. */
  date?: string;
  /** Provider relevance, DeepSeek: 0-3, >=1.5 is high quality. */
  rerankScore?: number;
  /** Provider authority, DeepSeek: 0-4, -1 unknown, >=3 highly authoritative. */
  authority?: number;
  /** The query that produced this hit and its 0-based rank within that query. */
  query: SearchQuery;
  rank: number;
}

export interface SearchProvider {
  name: string;
  /** `lang` is an ISO 639-1 code for the results' language, when the user's language is known. */
  search(query: SearchQuery, opts: { question?: string; count?: number; lang?: string; signal?: AbortSignal }): Promise<RawResult[]>;
  /** Optional page reader, used internally by the search pipeline (never exposed as a tool). */
  fetchPage?(url: string, signal?: AbortSignal): Promise<{ title: string; content: string } | null>;
}

/** A source as the model and UI see it. `n` is stable within a conversation: [n] always means the same page. */
export interface Source {
  n: number;
  url: string;
  title: string;
  /** Hostname without "www.", or the provider's site name. */
  site: string;
  published?: string;
  authority?: number;
  /** Query-relevant excerpts that were shown to the model (the grounding evidence). */
  passages: string[];
}

/** What the UI needs about a source (no passages). */
export type SourceSummary = Pick<Source, 'n' | 'url' | 'title' | 'site' | 'published'>;

export interface QueryStat {
  query: SearchQuery;
  hits: number;
  ms: number;
  cached: boolean;
  error?: string;
}

export interface SearchOutcome {
  /** Ranked, deduplicated sources for this call, already numbered by the registry. */
  sources: Source[];
  perQuery: QueryStat[];
  ms: number;
}

// ───────────────────────────── Memory ─────────────────────────────

export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListItem extends Conversation {
  turns: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Assistant only: the sources the answer cites, in citation order. */
  sources?: SourceSummary[];
  trace?: TurnTrace;
  verification?: Verification;
}

/** A checkable fact the assistant stated, recorded so it can be re-verified later. */
export interface Claim {
  subject: string; // "Neon"
  attribute: string; // "Launch plan price"
  value: string; // "$19/month"
  sourceUrl?: string;
  /** When the assistant stated it (= the turn's time). */
  asOf: string;
}

/** One completed question/answer exchange, the unit of long-term memory. */
export interface TurnMemory {
  /** The assistant message id. */
  messageId: string;
  conversationId: string;
  askedAt: string;
  question: string;
  answer: string;
  /** Filled asynchronously by the memory writer; null until then. */
  summary: string | null;
  topics: string[];
  entities: string[];
  claims: Claim[];
  sources: SourceSummary[];
}

export interface MemoryHit extends TurnMemory {
  conversationTitle: string | null;
  matchedBy: Array<'date' | 'keywords'>;
  score: number;
}

/** A time expression found in the user's message, resolved against the Clock. */
export interface TimeRef {
  /** The text as written, e.g. "last Tuesday". */
  text: string;
  /** Inclusive start / exclusive end, ISO UTC, covering whole days in the user's timezone. */
  start: string;
  end: string;
  /** Human label in the user's timezone, e.g. "Tue 3 Nov 2026" or "2 Nov – 8 Nov 2026". */
  label: string;
  /** Other plausible readings, e.g. "last Tuesday" said on a Thursday. Recall picks the one with evidence. */
  alternates?: Array<{ start: string; end: string; label: string }>;
}

export interface RecallResult {
  refs: TimeRef[];
  hits: MemoryHit[];
  /** Date references that matched no stored turns. The agent must say so instead of guessing. */
  emptyRefs: TimeRef[];
  /** Compact index of recent conversations, so the model always knows what memory holds. */
  index: ConversationListItem[];
  firstMemoryAt: string | null;
  ms: number;
}

// ───────────────────────────── Agent ─────────────────────────────

export interface TurnTrace {
  model: string;
  /** REASONING_EFFORT for this turn. */
  effort?: 'off' | 'low';
  steps: Array<{ queries: SearchQuery[]; ms: number; sources: number }>;
  /** Model steps that searched; more than one means it searched again for a gap. */
  searchRounds?: number;
  /**
   * firstActivityMs is when the user first saw something ("Thinking…" or the first token);
   * firstTokenMs is when the answer itself started. At low effort the gap is the thinking.
   */
  timings: {
    recallMs: number;
    firstActivityMs?: number | null;
    firstTokenMs: number | null;
    searchMs: number;
    thinkingMs?: number;
    totalMs: number;
  };
  /** completionTokens includes reasoningTokens. */
  usage: { promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens?: number };
  recall: { hits: number; refs: string[]; emptyRefs: string[] };
}

/** Citation check of an answer against the passages it was grounded on (via upheld). */
export interface Verification {
  status: 'ok' | 'error' | 'skipped';
  /** Cited claims that the sources back. */
  supported: number;
  cited: number;
  flagged: Array<{ claim: string; verdict: string; source?: string; note?: string }>;
  verifier?: string;
  ms: number;
  error?: string;
}

/** Server-sent events for one turn, in order: start, [memory], (search, sources)*, token*, done, [verification]. */
export type AgentEvent =
  | { type: 'start'; conversationId: string; userMessageId: string }
  | { type: 'memory'; hits: Array<{ askedAt: string; question: string; conversationTitle: string | null }>; refs: TimeRef[]; emptyRefs: TimeRef[] }
  | { type: 'status'; text: string }
  | { type: 'search'; step: number; queries: SearchQuery[] }
  | { type: 'sources'; step: number; sources: SourceSummary[] }
  | { type: 'token'; step: number; text: string }
  | { type: 'done'; messageId: string; content: string; sources: SourceSummary[]; trace: TurnTrace; title?: string }
  | { type: 'verification'; messageId: string; verification: Verification }
  | { type: 'error'; message: string };

export interface TurnInput {
  conversationId?: string;
  message: string;
  clock: Clock;
  signal?: AbortSignal;
}
