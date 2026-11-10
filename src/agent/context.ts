// Context assembly: everything the model needs for this message, built deterministically
// (no model call) before the first token. Two parts:
//   - history: the current conversation, so follow-ups work
//   - CONTEXT: time, resolved dates, and retrieved long-term memory, placed right before the
//     user's message so the static prompt + history stay a cacheable prefix.
import { DateTime } from 'luxon';
import type { Message } from '../llm/deepseek.js';
import { calendarBlock, formatDateTime, formatDay } from '../memory/temporal.js';
import type { Clock, MemoryHit, RecallResult, Source, StoredMessage } from '../types.js';
import { stripCitations } from './citations.js';

/** Exchanges of the current conversation sent verbatim. Older ones are reachable through memory. */
const HISTORY_MESSAGES = 24;
const PAST_ANSWER_CHARS = 3000;

export function historyMessages(prior: StoredMessage[]): { messages: Message[]; ids: Set<string> } {
  const recent = prior.slice(-HISTORY_MESSAGES);
  while (recent.length && recent[0].role !== 'user') recent.shift();
  return {
    messages: recent.map((m) => ({ role: m.role, content: m.content })),
    ids: new Set(recent.map((m) => m.id)),
  };
}

export function contextMessage(input: { clock: Clock; memory: RecallResult; conversationSources: Source[]; inHistory: Set<string> }): string {
  const { clock, memory } = input;
  const tz = clock.tz;
  const out: string[] = [];

  out.push('CONTEXT for this message (supplied by the app, not written by the user)', '');
  out.push(`Now: ${formatDateTime(clock.now.toISOString(), tz)} (${tz}); ISO date ${isoDay(clock.now.toISOString(), tz)}`);
  out.push(calendarBlock(clock, 14));

  if (memory.refs.length) {
    out.push('', 'Dates in the user\'s message, resolved:');
    const empty = new Set(memory.emptyRefs.map((r) => r.start + r.end));
    for (const r of memory.refs) {
      // Say what each date holds either way: left unsaid, the model has been seen to infer "no record".
      const n = memory.hits.filter((h) => h.askedAt >= r.start && h.askedAt < r.end).length;
      const holds = empty.has(r.start + r.end)
        ? ' — NO conversations with the user on this date'
        : n
          ? ` — ${n} past exchange${n === 1 ? '' : 's'} with the user on this date`
          : '';
      out.push(`- "${r.text}" = ${r.label}${holds}`);
    }
  }

  out.push('', '## Memory');
  if (!memory.firstMemoryAt) {
    out.push('You have no past conversations with this user yet.');
  } else {
    out.push(`Your memory of this user starts ${formatDay(memory.firstMemoryAt, tz)}.`);
    const others = memory.index;
    if (others.length) {
      out.push('', 'Other recent conversations (newest first):');
      for (const c of others) {
        out.push(`- ${formatDateTime(c.updatedAt, tz)} · "${c.title ?? 'Untitled'}" · ${c.turns} exchange${c.turns === 1 ? '' : 's'}`);
      }
    }
  }

  // Exchanges already in the history above need no second copy.
  const hits = memory.hits.filter((h) => !input.inHistory.has(h.messageId)).sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  if (hits.length) {
    out.push('', 'Past exchanges retrieved for this message (oldest first). They are your own earlier words, not verified facts. Source numbers from those conversations are not valid here; cite only sources from this conversation.');
    for (const h of hits) out.push('', ...pastExchange(h, tz));
  } else if (memory.firstMemoryAt) {
    out.push('', 'No past exchange matched this message.');
  }

  if (input.conversationSources.length) {
    out.push('', 'Sources already cited in this conversation (you may cite these numbers again):');
    for (const s of input.conversationSources) out.push(`[${s.n}] ${s.title} — ${s.url}`);
  }

  return out.join('\n');
}

function pastExchange(h: MemoryHit, tz: string): string[] {
  const lines = [`### ${formatDateTime(h.askedAt, tz)} (${isoDay(h.askedAt, tz)}) · conversation "${h.conversationTitle ?? 'Untitled'}"`];
  lines.push(`The user asked: ${h.question}`);
  let answer = stripCitations(h.answer).trim();
  if (answer.length > PAST_ANSWER_CHARS) answer = `${answer.slice(0, PAST_ANSWER_CHARS)}… [truncated]`;
  lines.push('You answered:', answer);
  if (h.claims.length) {
    lines.push(`Checkable claims you made then (as of ${formatDay(h.askedAt, tz)}):`);
    for (const c of h.claims) lines.push(`- ${c.subject} · ${c.attribute}: ${c.value}${c.sourceUrl ? ` (source: ${c.sourceUrl})` : ''}`);
  }
  if (h.sources.length) lines.push(`Sources you used then: ${h.sources.map((s) => s.url).join(', ')}`);
  return lines;
}

const isoDay = (iso: string, tz: string): string => DateTime.fromISO(iso, { zone: tz }).toISODate() ?? iso.slice(0, 10);
