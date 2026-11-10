// Terminal chat: `npm run chat`. Uses the same runTurn and memory store as the web app.
// /new starts a fresh conversation, /exit quits, Ctrl+C stops a running answer (or quits when idle).
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { assertConfig, config } from './config.js';
import { flushBackground, runTurn } from './agent/orchestrator.js';
import { openStore } from './memory/db.js';
import { formatDay } from './memory/temporal.js';
import type { AgentEvent, SearchQuery, TurnTrace } from './types.js';

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const write = (s: string) => process.stdout.write(s);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function queryLabel(q: SearchQuery): string {
  const ops = [q.site ? `site:${q.site}` : '', q.after ? `after:${q.after}` : ''].filter(Boolean);
  return ops.length ? `${q.q} (${ops.join(', ')})` : q.q;
}

function secs(ms: number | null | undefined): string {
  return typeof ms === 'number' ? `${(ms / 1000).toFixed(1)}s` : '-';
}

function traceLine(trace: TurnTrace): string {
  const steps = trace.steps.length;
  return `${secs(trace.timings.totalMs)} total · first token ${secs(trace.timings.firstTokenMs)} · ${steps} search step${steps === 1 ? '' : 's'} · ${trace.usage.promptTokens} prompt tokens`;
}

/**
 * Renders one turn's events. Text from the highest step streams as it arrives. Text from
 * earlier steps (the model talking before a search) is held and shown dim when the next search
 * event arrives, so it reads as narration rather than as the answer.
 */
class TurnRenderer {
  private top = -1;
  private headerShown = false;
  private held = new Map<number, string>();

  constructor(private readonly tz: string) {}

  onEvent(e: AgentEvent): void {
    switch (e.type) {
      case 'start':
        return;
      case 'memory': {
        for (const h of e.hits) {
          const title = h.conversationTitle ? `${h.conversationTitle} · ` : '';
          write(dim(`  memory  ${formatDay(h.askedAt, this.tz)} · ${title}${truncate(h.question, 100)}`) + '\n');
        }
        for (const r of e.refs) write(dim(`  dates   "${r.text}" = ${r.label}`) + '\n');
        for (const r of e.emptyRefs) write(dim(`  no record of ${r.label} ("${r.text}")`) + '\n');
        return;
      }
      case 'status':
        write(dim(`  ${e.text}`) + '\n');
        return;
      case 'search':
        this.flushHeld();
        write(dim(`  searching: ${e.queries.map(queryLabel).join(' · ') || '(no queries)'}`) + '\n');
        return;
      case 'sources':
        return;
      case 'token':
        if (e.step > this.top) {
          this.flushHeld();
          this.top = e.step;
        }
        if (e.step === this.top) this.stream(e.text);
        else this.held.set(e.step, (this.held.get(e.step) ?? '') + e.text);
        return;
      case 'done':
        this.flushHeld();
        write('\n');
        if (e.sources.length) {
          write(bold('sources') + '\n');
          for (const s of e.sources) write(`  [${s.n}] ${s.title} — ${s.url}\n`);
        }
        write(dim(traceLine(e.trace)) + '\n');
        return;
      case 'verification': {
        const v = e.verification;
        if (v.status === 'ok') {
          write(dim(`  citations: ${v.supported}/${v.cited} supported`) + '\n');
          for (const f of v.flagged.slice(0, 5)) write(dim(`  ! ${truncate(f.claim, 120)} (${f.verdict})`) + '\n');
        } else if (v.status === 'error') {
          write(dim(`  citation check failed: ${v.error ?? 'unknown error'}`) + '\n');
        }
        return;
      }
      case 'error':
        write(red(`\nerror: ${e.message}`) + '\n');
        return;
    }
  }

  /** Shows any held narration as dim text. Called when a search starts and when the turn ends. */
  flushHeld(): void {
    for (const [, text] of [...this.held.entries()].sort(([a], [b]) => a - b)) {
      const t = text.trim();
      if (t) write(dim(t) + '\n');
    }
    this.held.clear();
  }

  private stream(text: string): void {
    if (!this.headerShown) {
      write(`${bold('assistant ›')} `);
      this.headerShown = true;
    }
    write(text);
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

async function main(): Promise<void> {
  assertConfig();
  const store = openStore();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let conversationId: string | undefined;
  let running: AbortController | null = null;
  let exiting = false;

  const exit = async (): Promise<void> => {
    if (exiting) return;
    exiting = true;
    // Let memory notes from the last turn finish, but don't hang the exit on them.
    await Promise.race([flushBackground(), sleep(5_000)]);
    process.exit(0);
  };

  rl.on('SIGINT', () => {
    if (running) {
      running.abort();
      write(dim('\n(stopping)\n'));
    } else {
      rl.close();
    }
  });
  // Input can end while an answer is still streaming (piped stdin): finish that answer first.
  let closed = false;
  rl.on('close', () => {
    closed = true;
    if (!running) void exit();
  });

  write(`${bold('since')} ${dim(`· ${config.chatModel} · ${config.defaultTz}`)}\n`);
  write(dim('Ask anything. /new starts a fresh conversation, /exit quits, Ctrl+C stops an answer.') + '\n\n');

  for (;;) {
    let line: string;
    try {
      line = (await rl.question('you › ')).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === '/exit') {
      rl.close();
      break;
    }
    if (line === '/new') {
      conversationId = undefined;
      write(dim('started a new conversation') + '\n');
      continue;
    }

    const controller = new AbortController();
    running = controller;
    const renderer = new TurnRenderer(config.defaultTz);
    try {
      const result = await runTurn(
        { conversationId, message: line, clock: { now: new Date(), tz: config.defaultTz }, signal: controller.signal },
        (e) => {
          if (e.type === 'start') conversationId = e.conversationId;
          renderer.onEvent(e);
        },
        { store },
      );
      conversationId = result.conversationId;
    } catch (err) {
      renderer.flushHeld();
      if (controller.signal.aborted) write(dim('(stopped)') + '\n');
      else write(red(`\nerror: ${err instanceof Error ? err.message : String(err)}`) + '\n');
    } finally {
      running = null;
    }
    write('\n');
    if (closed) break;
  }
  await exit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
