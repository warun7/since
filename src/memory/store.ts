// Persistence for conversations, messages, sources and turn memory.
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { openDb } from './db.js';
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
  constructor(private readonly db: Database.Database) {}

  static open(path?: string): MemoryStore {
    return new MemoryStore(openDb(path));
  }

  // ───────────────────────── Conversations ─────────────────────────

  createConversation(at?: Date): Conversation {
    const id = crypto.randomUUID();
    // ISO strings with a fixed UTC format sort correctly as text, which the range queries rely on.
    const iso = (at ?? new Date()).toISOString();
    this.db
      .prepare('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)')
      .run(id, iso, iso);
    return { id, title: null, createdAt: iso, updatedAt: iso };
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
    return row ? toConversation(row) : null;
  }

  listConversations(limit = 100): ConversationListItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turns
           FROM conversations c
          WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
          ORDER BY c.updated_at DESC
          LIMIT ?`,
      )
      .all(limit) as Array<ConversationRow & { turns: number }>;
    return rows.map((r) => ({ ...toConversation(r), turns: r.turns }));
  }

  deleteConversation(id: string): void {
    // The foreign-key cascade removes the turns rows but cannot reach the FTS table, so its
    // rows are removed first, while the turns that name them still exist.
    this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM turns_fts WHERE message_id IN (SELECT message_id FROM turns WHERE conversation_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id);
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
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO messages (id, conversation_id, role, content, created_at, sources_json, trace_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          m.conversationId,
          m.role,
          m.content,
          createdAt,
          m.sources ? JSON.stringify(m.sources) : null,
          m.trace ? JSON.stringify(m.trace) : null,
        );
      // Seeds pass backdated times, so the conversation takes the message's time rather than "now".
      this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(createdAt, m.conversationId);
    })();
    return toMessage(
      this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow,
    );
  }

  setVerification(messageId: string, v: Verification): void {
    this.db
      .prepare('UPDATE messages SET verification_json = ? WHERE id = ?')
      .run(JSON.stringify(v), messageId);
  }

  getMessages(conversationId: string): StoredMessage[] {
    // rowid breaks ties between messages with the same timestamp, in the order they were written.
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid')
      .all(conversationId) as MessageRow[];
    return rows.map(toMessage);
  }

  // ───────────────────────── Sources ─────────────────────────

  saveSources(conversationId: string, sources: Source[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO sources (conversation_id, n, url, title, site, published, authority, passages_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, n) DO UPDATE SET
         url = excluded.url, title = excluded.title, site = excluded.site,
         published = excluded.published, authority = excluded.authority,
         passages_json = excluded.passages_json`,
    );
    this.db.transaction(() => {
      for (const s of sources) {
        // better-sqlite3 rejects undefined as a bind value, so optional fields become NULL.
        upsert.run(
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
    })();
  }

  getSources(conversationId: string): Source[] {
    const rows = this.db
      .prepare('SELECT * FROM sources WHERE conversation_id = ? ORDER BY n')
      .all(conversationId) as SourceRow[];
    return rows.map(toSource);
  }

  // ───────────────────────── Turn memory ─────────────────────────

  saveTurn(t: TurnMemory): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO turns (message_id, conversation_id, asked_at, question, answer, summary,
                              topics_json, entities_json, claims_json, sources_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (message_id) DO UPDATE SET
             conversation_id = excluded.conversation_id, asked_at = excluded.asked_at,
             question = excluded.question, answer = excluded.answer, summary = excluded.summary,
             topics_json = excluded.topics_json, entities_json = excluded.entities_json,
             claims_json = excluded.claims_json, sources_json = excluded.sources_json`,
        )
        .run(
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
    })();
  }

  updateTurnNotes(
    messageId: string,
    notes: { summary: string; topics: string[]; entities: string[]; claims: Claim[] },
  ): void {
    this.db.transaction(() => {
      const turn = this.getTurn(messageId);
      if (!turn) return;
      this.db
        .prepare(
          'UPDATE turns SET summary = ?, topics_json = ?, entities_json = ?, claims_json = ? WHERE message_id = ?',
        )
        .run(notes.summary, JSON.stringify(notes.topics), JSON.stringify(notes.entities), JSON.stringify(notes.claims), messageId);
      this.indexTurn({ ...turn, ...notes });
    })();
  }

  getTurn(messageId: string): TurnMemory | null {
    const row = this.db.prepare('SELECT * FROM turns WHERE message_id = ?').get(messageId) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  turnsBetween(startIso: string, endIso: string): Array<TurnMemory & { conversationTitle: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT t.*, c.title AS conversation_title
           FROM turns t JOIN conversations c ON c.id = t.conversation_id
          WHERE t.asked_at >= ? AND t.asked_at < ?
          ORDER BY t.asked_at ASC`,
      )
      .all(startIso, endIso) as Array<TurnRow & { conversation_title: string | null }>;
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
    try {
      const rows = this.db
        .prepare(
          `SELECT t.*, c.title AS conversation_title, bm25(turns_fts) AS rank
             FROM turns_fts
             JOIN turns t ON t.message_id = turns_fts.message_id
             JOIN conversations c ON c.id = t.conversation_id
            WHERE turns_fts MATCH ? AND (? IS NULL OR t.conversation_id != ?)
            ORDER BY rank
            LIMIT ?`,
        )
        .all(expr, opts.excludeConversationId ?? null, opts.excludeConversationId ?? null, opts.limit ?? 8) as Array<
        TurnRow & { conversation_title: string | null; rank: number }
      >;
      // bm25 is negative and lower is better, so negate it: a higher score is a better match.
      return rows.map((r) => ({ ...toTurn(r), conversationTitle: r.conversation_title, score: -r.rank }));
    } catch {
      // A malformed MATCH expression should degrade to "no keyword hits", not fail the turn.
      return [];
    }
  }

  recentConversations(limit = 15, excludeId?: string): ConversationListItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COUNT(t.message_id) AS turns
           FROM conversations c JOIN turns t ON t.conversation_id = c.id
          WHERE (? IS NULL OR c.id != ?)
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ?`,
      )
      .all(excludeId ?? null, excludeId ?? null, limit) as Array<ConversationRow & { turns: number }>;
    return rows.map((r) => ({ ...toConversation(r), turns: r.turns }));
  }

  firstTurnAt(): string | null {
    const row = this.db.prepare('SELECT MIN(asked_at) AS first FROM turns').get() as { first: string | null };
    return row.first;
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
    this.db.prepare('DELETE FROM turns_fts WHERE message_id = ?').run(t.messageId);
    this.db.prepare('INSERT INTO turns_fts (message_id, body) VALUES (?, ?)').run(t.messageId, body);
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
