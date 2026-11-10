// Persistence for conversations, messages, sources and turn memory.
import type {
  Claim,
  Conversation,
  ConversationListItem,
  Source,
  SourceSummary,
  StoredMessage,
  TurnMemory,
  TurnTrace,
  Verification,
} from '../types.js';
import type { Sql } from './sql.js';

// Rows are read as the raw SQLite shapes; the mappers below turn them into the shared types.
interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  sources_json: string | null;
  trace_json: string | null;
  verification_json: string | null;
}

interface SourceRow {
  n: number;
  url: string;
  title: string | null;
  site: string | null;
  published: string | null;
  authority: number | null;
  passages_json: string;
}

interface TurnRow {
  message_id: string;
  conversation_id: string;
  asked_at: string;
  question: string;
  answer: string;
  summary: string | null;
  topics_json: string;
  entities_json: string;
  claims_json: string;
  sources_json: string;
}

/** How much of the answer goes into the search index. Long answers repeat their own vocabulary. */
const FTS_ANSWER_CHARS = 1500;

export class MemoryStore {
  constructor(private readonly sql: Sql) {}

  // ───────────────────────── Conversations ─────────────────────────

  createConversation(at?: Date): Conversation {
    const id = crypto.randomUUID();
    // ISO strings with a fixed UTC format sort correctly as text, which the range queries rely on.
    const iso = (at ?? new Date()).toISOString();
    this.sql.run('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)', id, iso, iso);
    return { id, title: null, createdAt: iso, updatedAt: iso };
  }

  getConversation(id: string): Conversation | null {
    const row = this.sql.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id);
    return row ? toConversation(row) : null;
  }

  listConversations(limit = 100): ConversationListItem[] {
    const rows = this.sql.all<ConversationRow & { turns: number }>(
      `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
         FROM conversations c
        WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
        ORDER BY c.updated_at DESC
        LIMIT ?`,
      limit,
    );
    return rows.map((r) => ({ ...toConversation(r), turns: r.turns }));
  }

  deleteConversation(id: string): void {
    // The foreign-key cascade removes the turns rows but cannot reach the FTS table, so its
    // rows are removed first, while the turns that name them still exist.
    this.sql.transaction(() => {
      this.sql.run('DELETE FROM turns_fts WHERE message_id IN (SELECT message_id FROM turns WHERE conversation_id = ?)', id);
      this.sql.run('DELETE FROM conversations WHERE id = ?', id);
    });
  }

  /** Deletes everything this memory holds. */
  clearAll(): void {
    this.sql.transaction(() => {
      for (const table of ['turns_fts', 'sources', 'turns', 'messages', 'conversations']) this.sql.run(`DELETE FROM ${table}`);
    });
  }

  setTitle(id: string, title: string): void {
    this.sql.run('UPDATE conversations SET title = ? WHERE id = ?', title, id);
  }

  // ───────────────────────── Messages ─────────────────────────

  addMessage(m: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt?: Date;
    sources?: SourceSummary[];
    trace?: TurnTrace;
    id?: string;
  }): StoredMessage {
    const id = m.id ?? crypto.randomUUID();
    const createdAt = (m.createdAt ?? new Date()).toISOString();
    this.sql.transaction(() => {
      this.sql.run(
        `INSERT INTO messages (id, conversation_id, role, content, created_at, sources_json, trace_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        m.conversationId,
        m.role,
        m.content,
        createdAt,
        m.sources ? JSON.stringify(m.sources) : null,
        m.trace ? JSON.stringify(m.trace) : null,
      );
      // Seeds pass backdated times, so the conversation takes the message's time rather than "now".
      this.sql.run('UPDATE conversations SET updated_at = ? WHERE id = ?', createdAt, m.conversationId);
    });
    return toMessage(this.sql.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!);
  }

  setVerification(messageId: string, v: Verification): void {
    this.sql.run('UPDATE messages SET verification_json = ? WHERE id = ?', JSON.stringify(v), messageId);
  }

  getMessages(conversationId: string): StoredMessage[] {
    // rowid breaks ties between messages with the same timestamp, in the order they were written.
    const rows = this.sql.all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', conversationId);
    return rows.map(toMessage);
  }

  /** How many questions the user has asked since a time. Backdated (seeded) messages don't count. */
  questionsSince(iso: string): number {
    return this.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?", iso)!.n;
  }

  // ───────────────────────── Sources ─────────────────────────

  saveSources(conversationId: string, sources: Source[]): void {
    const upsert = `INSERT INTO sources (conversation_id, n, url, title, site, published, authority, passages_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (conversation_id, n) DO UPDATE SET
                      url = excluded.url, title = excluded.title, site = excluded.site,
                      published = excluded.published, authority = excluded.authority,
                      passages_json = excluded.passages_json`;
    this.sql.transaction(() => {
      for (const s of sources) {
        // Neither SQLite driver accepts undefined as a bind value, so optional fields become NULL.
        this.sql.run(
          upsert,
          conversationId,
          s.n,
          s.url,
          s.title ?? null,
          s.site ?? null,
          s.published ?? null,
          s.authority ?? null,
          JSON.stringify(s.passages ?? []),
        );
      }
    });
  }

  getSources(conversationId: string): Source[] {
    return this.sql.all<SourceRow>('SELECT * FROM sources WHERE conversation_id = ? ORDER BY n', conversationId).map(toSource);
  }

  // ───────────────────────── Turn memory ─────────────────────────

  saveTurn(t: TurnMemory): void {
    this.sql.transaction(() => {
      this.sql.run(
        `INSERT INTO turns (message_id, conversation_id, asked_at, question, answer, summary,
                            topics_json, entities_json, claims_json, sources_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (message_id) DO UPDATE SET
           conversation_id = excluded.conversation_id, asked_at = excluded.asked_at,
           question = excluded.question, answer = excluded.answer, summary = excluded.summary,
           topics_json = excluded.topics_json, entities_json = excluded.entities_json,
           claims_json = excluded.claims_json, sources_json = excluded.sources_json`,
        t.messageId,
        t.conversationId,
        t.askedAt,
        t.question,
        t.answer,
        t.summary ?? null,
        JSON.stringify(t.topics ?? []),
        JSON.stringify(t.entities ?? []),
        JSON.stringify(t.claims ?? []),
        JSON.stringify(t.sources ?? []),
      );
      this.indexTurn(t);
    });
  }

  updateTurnNotes(messageId: string, notes: { summary: string; topics: string[]; entities: string[]; claims: Claim[] }): void {
    this.sql.transaction(() => {
      const turn = this.getTurn(messageId);
      if (!turn) return;
      this.sql.run(
        'UPDATE turns SET summary = ?, topics_json = ?, entities_json = ?, claims_json = ? WHERE message_id = ?',
        notes.summary,
        JSON.stringify(notes.topics),
        JSON.stringify(notes.entities),
        JSON.stringify(notes.claims),
        messageId,
      );
      this.indexTurn({ ...turn, ...notes });
    });
  }

  getTurn(messageId: string): TurnMemory | null {
    const row = this.sql.get<TurnRow>('SELECT * FROM turns WHERE message_id = ?', messageId);
    return row ? toTurn(row) : null;
  }

  turnsBetween(startIso: string, endIso: string): Array<TurnMemory & { conversationTitle: string | null }> {
    const rows = this.sql.all<TurnRow & { conversation_title: string | null }>(
      `SELECT t.*, c.title AS conversation_title
         FROM turns t JOIN conversations c ON c.id = t.conversation_id
        WHERE t.asked_at >= ? AND t.asked_at < ?
        ORDER BY t.asked_at ASC`,
      startIso,
      endIso,
    );
    return rows.map((r) => ({ ...toTurn(r), conversationTitle: r.conversation_title }));
  }

  searchTurns(
    terms: string[],
    opts: { limit?: number; excludeConversationId?: string } = {},
  ): Array<TurnMemory & { conversationTitle: string | null; score: number }> {
    const expr = terms
      .filter((t) => t.trim() !== '')
      // Each term is a quoted FTS string, so punctuation in it cannot act as FTS syntax.
      .map((t) => `"${t.replace(/"/g, '""')}"`)
      .join(' OR ');
    if (!expr) return [];
    const exclude = opts.excludeConversationId ?? null;
    try {
      const rows = this.sql.all<TurnRow & { conversation_title: string | null; rank: number }>(
        `SELECT t.*, c.title AS conversation_title, bm25(turns_fts) AS rank
           FROM turns_fts
           JOIN turns t ON t.message_id = turns_fts.message_id
           JOIN conversations c ON c.id = t.conversation_id
          WHERE turns_fts MATCH ? AND (? IS NULL OR t.conversation_id != ?)
          ORDER BY rank
          LIMIT ?`,
        expr,
        exclude,
        exclude,
        opts.limit ?? 8,
      );
      // bm25 is negative and lower is better, so negate it: a higher score is a better match.
      return rows.map((r) => ({ ...toTurn(r), conversationTitle: r.conversation_title, score: -r.rank }));
    } catch {
      // A malformed MATCH expression should degrade to "no keyword hits", not fail the turn.
      return [];
    }
  }

  recentConversations(limit = 15, excludeId?: string): ConversationListItem[] {
    const exclude = excludeId ?? null;
    const rows = this.sql.all<ConversationRow & { turns: number }>(
      `SELECT c.*, COUNT(t.message_id) AS turns
         FROM conversations c JOIN turns t ON t.conversation_id = c.id
        WHERE (? IS NULL OR c.id != ?)
        GROUP BY c.id
        ORDER BY c.updated_at DESC
        LIMIT ?`,
      exclude,
      exclude,
      limit,
    );
    return rows.map((r) => ({ ...toConversation(r), turns: r.turns }));
  }

  isEmpty(): boolean {
    return !this.sql.get('SELECT 1 FROM conversations LIMIT 1');
  }

  firstTurnAt(): string | null {
    return this.sql.get<{ first: string | null }>('SELECT MIN(asked_at) AS first FROM turns')?.first ?? null;
  }

  /** Replace a turn's row in the search index. Called after every write that changes its text. */
  private indexTurn(t: TurnMemory): void {
    const body = [
      t.question,
      t.answer.slice(0, FTS_ANSWER_CHARS),
      t.summary ?? '',
      (t.topics ?? []).join(' '),
      (t.entities ?? []).join(' '),
      (t.claims ?? []).map((c) => `${c.subject} ${c.attribute} ${c.value}`).join('\n'),
    ].join('\n');
    this.sql.run('DELETE FROM turns_fts WHERE message_id = ?', t.messageId);
    this.sql.run('INSERT INTO turns_fts (message_id, body) VALUES (?, ?)', t.messageId, body);
  }
}

// ───────────────────────── Row mappers ─────────────────────────

function parseJson<T>(s: string | null): T | undefined {
  return s == null ? undefined : (JSON.parse(s) as T);
}

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at };
}

function toMessage(r: MessageRow): StoredMessage {
  const m: StoredMessage = {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  };
  // Optional fields are left off entirely, rather than set to undefined, so the shape stays clean.
  const sources = parseJson<SourceSummary[]>(r.sources_json);
  const trace = parseJson<TurnTrace>(r.trace_json);
  const verification = parseJson<Verification>(r.verification_json);
  if (sources) m.sources = sources;
  if (trace) m.trace = trace;
  if (verification) m.verification = verification;
  return m;
}

function toSource(r: SourceRow): Source {
  const s: Source = {
    n: r.n,
    url: r.url,
    title: r.title ?? '',
    site: r.site ?? '',
    passages: JSON.parse(r.passages_json) as string[],
  };
  if (r.published != null) s.published = r.published;
  if (r.authority != null) s.authority = r.authority;
  return s;
}

function toTurn(r: TurnRow): TurnMemory {
  return {
    messageId: r.message_id,
    conversationId: r.conversation_id,
    askedAt: r.asked_at,
    question: r.question,
    answer: r.answer,
    summary: r.summary,
    topics: JSON.parse(r.topics_json) as string[],
    entities: JSON.parse(r.entities_json) as string[],
    claims: JSON.parse(r.claims_json) as Claim[],
    sources: JSON.parse(r.sources_json) as SourceSummary[],
  };
}
