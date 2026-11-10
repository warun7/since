// Writes memory notes for a finished exchange. Runs in the background after the answer has been
// sent, so it is never on the chat's critical path.
import { chatJSON } from '../llm/deepseek.js';
import type { Claim, SourceSummary, TurnMemory } from '../types.js';
import type { MemoryStore } from './store.js';

export interface MemoryNotes {
  title?: string;
  summary: string;
  topics: string[];
  entities: string[];
  claims: Claim[];
}

type JsonLLM = (system: string, user: string) => Promise<unknown>;

interface NotesInput {
  question: string;
  answer: string;
  sources: SourceSummary[];
  askedAt: string;
  needsTitle: boolean;
}

const SYSTEM_PROMPT = `You maintain the long-term memory of a research assistant. You get one exchange: the user's question and the assistant's answer, whose [n] markers cite the numbered sources. Reply with JSON only:
{"title": "3-6 word title for the conversation, or null if not requested", "summary": "1-2 sentences: what the user wanted and what the assistant concluded, keeping key names and numbers", "topics": ["2-5 short lowercase topic phrases"], "entities": ["products, companies, people or places the answer is about"], "claims": [{"subject": "Neon", "attribute": "Launch plan price", "value": "$19/month", "source": 3}]}
Claims are the checkable facts in the answer that can change over time and that the user may later ask to re-verify: prices, plan limits, version numbers, release or availability status, rankings, policies, upcoming dates, people's roles. One claim per fact. Copy the value exactly as the answer states it, with currency and units. "source" is the [n] the answer cited for that fact, or null. At most 20 claims. Timeless facts and opinions are not claims. If there are none, return an empty list.`;

const defaultLLM: JsonLLM = (system, user) => chatJSON<unknown>(system, user);

/** Trims a model-supplied string and caps its length. Returns undefined for anything unusable. */
function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

/** Cleaned, de-duplicated string list, capped in length and count. */
function cleanList(v: unknown, max: number, count: number, lower = false): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const s = clean(item, max);
    if (!s) continue;
    const value = lower ? s.toLowerCase() : s;
    if (!out.includes(value)) out.push(value);
    if (out.length >= count) break;
  }
  return out;
}

/** Plain text of the answer, for when the model is unavailable. Keeps the first 300 characters. */
function fallbackNotes(answer: string): MemoryNotes {
  const summary = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\d+\]/g, '')
    .replace(/[`*_#>~|]/g, '')
    .replace(/^\s*(?:[-+]|\d+\.)\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return { summary, topics: [], entities: [], claims: [] };
}

function userMessage(i: NotesInput): string {
  const sources = i.sources.length
    ? i.sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n')
    : '(none)';
  return [
    `Title requested: ${i.needsTitle ? 'yes' : 'no'}`,
    `Asked at: ${i.askedAt}`,
    '',
    'QUESTION:',
    i.question,
    '',
    'ANSWER:',
    i.answer,
    '',
    'SOURCES:',
    sources,
  ].join('\n');
}

/**
 * Turns a model reply into notes. The model is untrusted: every field is type-checked, capped,
 * and dropped when unusable, so one bad field never discards the whole reply.
 */
function parseNotes(raw: unknown, input: NotesInput): MemoryNotes {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const claims: Claim[] = [];
  if (Array.isArray(o.claims)) {
    for (const item of o.claims) {
      if (claims.length >= 20) break;
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const subject = clean(c.subject, 200);
      const attribute = clean(c.attribute, 200);
      const value = clean(c.value, 200);
      // A claim without all three parts cannot be re-checked later, so it is not kept.
      if (!subject || !attribute || !value) continue;
      // The model cites by [n]. The stored claim keeps the URL, since the number is local to one answer.
      const n = typeof c.source === 'number' ? c.source : Number(c.source);
      const sourceUrl = Number.isInteger(n) ? input.sources.find((s) => s.n === n)?.url : undefined;
      claims.push({
        subject,
        attribute,
        value,
        ...(sourceUrl ? { sourceUrl } : {}),
        asOf: input.askedAt,
      });
    }
  }

  const notes: MemoryNotes = {
    summary: clean(o.summary, 600) ?? fallbackNotes(input.answer).summary,
    topics: cleanList(o.topics, 60, 5, true),
    entities: cleanList(o.entities, 60, 12),
    claims,
  };
  // A title is only wanted when the conversation has none yet. Ignore one that came back unrequested.
  const title = input.needsTitle ? clean(o.title, 80) : undefined;
  if (title) notes.title = title;
  return notes;
}

export async function writeMemoryNotes(input: NotesInput, llm: JsonLLM = defaultLLM): Promise<MemoryNotes> {
  try {
    const raw = await llm(SYSTEM_PROMPT, userMessage(input));
    return parseNotes(raw, input);
  } catch (err) {
    // Memory still needs something to search on, so store the plain answer text instead of nothing.
    console.warn('memory: notes call failed, storing fallback notes', err);
    return fallbackNotes(input.answer);
  }
}

/**
 * Writes notes for one turn, and the conversation title when one was requested. Never throws:
 * a failed write is logged, since losing a note must not break the chat.
 */
export async function processTurn(
  store: MemoryStore,
  turn: TurnMemory,
  needsTitle: boolean,
  llm?: JsonLLM,
): Promise<MemoryNotes> {
  const notes = await writeMemoryNotes(
    { question: turn.question, answer: turn.answer, sources: turn.sources, askedAt: turn.askedAt, needsTitle },
    llm,
  ).catch((err: unknown) => {
    console.warn('memory: could not write notes', err);
    return fallbackNotes(turn.answer);
  });
  try {
    // saveTurn is an upsert, so this also works when the turn row was not written yet.
    store.saveTurn({
      ...turn,
      summary: notes.summary,
      topics: notes.topics,
      entities: notes.entities,
      claims: notes.claims,
    });
    if (notes.title) store.setTitle(turn.conversationId, notes.title);
  } catch (err) {
    console.warn('memory: could not save notes', err);
  }
  return notes;
}
