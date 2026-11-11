// since: browser UI for the chat agent. One ES module, no framework, no build step.
import { marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

/* ============================================================
 * Constants, DOM handles, helpers, formatting
 * ============================================================ */

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const NEAR_BOTTOM_PX = 120;
const EXAMPLES = [
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  "What's the latest stable Node.js release and what changed?",
  'Compare Linear, Jira and Height for a 15-person startup',
];

const dom = {
  convList: document.querySelector('#conv-list'),
  newChat: document.querySelector('#new-chat'),
  forgetAll: document.querySelector('#forget-all'),
  menuBtn: document.querySelector('#menu-btn'),
  scrim: document.querySelector('#scrim'),
  title: document.querySelector('#title'),
  thread: document.querySelector('#thread'),
  threadInner: document.querySelector('#thread-inner'),
  form: document.querySelector('#composer'),
  input: document.querySelector('#input'),
  send: document.querySelector('#send-btn'),
};

// Links produced by markdown open in a new tab without leaking the opener.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Tiny element builder. Attribute values of null/undefined/false are skipped. */
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  const nodes = children
    .flat()
    .filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : String(c)));
  node.append(...nodes);
  return node;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const fmtSecs = (ms) => `${((ms ?? 0) / 1000).toFixed(1)}s`;
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const dayYearFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const fmtDay = (d) => (d.getFullYear() === new Date().getFullYear() ? dayFmt : dayYearFmt).format(d);
const fmtTime = (d) => timeFmt.format(d);
const fmtDateTime = (d) => `${fmtDay(d)}, ${fmtTime(d)}`;

/** Accepts "YYYY-MM-DD" (read as a local calendar day) or any ISO timestamp. */
function parseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDateOnly(s) {
  const d = parseDate(s);
  return d ? dateFmt.format(d) : '';
}

function hashId() {
  const m = /^#c=(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/* ============================================================
 * api: JSON calls to the same origin
 * ============================================================ */

async function errorFrom(res) {
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') return body.error;
    if (typeof body?.message === 'string') return body.message;
  } catch {
    // not JSON; fall through
  }
  return `Request failed (HTTP ${res.status})`;
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(await errorFrom(res));
  return res.json();
}

const api = {
  health: () => getJSON('/api/health'),
  conversations: async () => (await getJSON('/api/conversations')).conversations,
  conversation: (id) => getJSON(`/api/conversations/${encodeURIComponent(id)}`),
  async remove(id) {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorFrom(res));
  },
  async removeAll() {
    const res = await fetch('/api/conversations', { method: 'DELETE' });
    if (!res.ok) throw new Error(await errorFrom(res));
  },
};

/* ============================================================
 * sse: read `data:` blocks from a fetch body stream
 * ============================================================ */

async function readEvents(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return; // malformed frame: skip it
    }
    onEvent(ev);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop();
    for (const block of blocks) dispatch(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
}

/* ============================================================
 * state and view models
 * ============================================================ */

const state = {
  health: { ok: false, upheld: false, model: '', search: '' },
  conversations: [],
  conversationsLoaded: false,
  conversationId: null, // open conversation; null means a new chat
  convSources: new Map(), // n -> SourceSummary for earlier turns of the open conversation
  activeTurn: null, // the turn currently streaming, if any
};

function newTurn({ message, conversationId, userEl }) {
  return {
    message,
    conversationId: conversationId ?? null,
    userEl,
    parts: null,
    controller: null,
    startedAt: performance.now(),
    endedAt: 0,
    texts: new Map(), // step -> streamed text
    searches: [], // { step, queries, sources: SourceSummary[] | null }
    memory: null,
    status: null,
    sourceMap: new Map(), // n -> SourceSummary, this turn only
    done: null,
    error: null,
    stopped: false,
    finished: false,
    verifying: false,
    raf: 0,
    dirty: { answer: false, activity: false },
  };
}

/** Highest step seen so far, counting both token steps and search steps. */
function maxStep(turn) {
  let max = null;
  for (const step of [...turn.texts.keys(), ...turn.searches.map((s) => s.step)]) {
    if (max === null || step > max) max = step;
  }
  return max;
}

/** The answer is the text of the highest step; done.content is authoritative once it arrives. */
function answerText(turn) {
  if (turn.done) return turn.done.content ?? '';
  const top = maxStep(turn);
  return top === null ? '' : (turn.texts.get(top) ?? '');
}

const labelOf = (r) => (typeof r === 'string' ? r : r.label);

function uniqueSites(sources) {
  return [...new Set(sources.map((s) => s.site).filter(Boolean))].slice(0, 6);
}

/** Activity model for a live turn. */
function liveView(turn) {
  const top = maxStep(turn);
  const stepIds = new Set([...turn.texts.keys(), ...turn.searches.map((s) => s.step)]);
  const steps = [...stepIds].sort((a, b) => a - b).map((step) => {
    const text = turn.texts.get(step)?.trim();
    return {
      preamble: text && top !== null && step < top ? text : null,
      searches: turn.searches
        .filter((s) => s.step === step)
        .map((s) => ({
          queries: s.queries,
          pending: s.sources === null && !turn.finished,
          sourceCount: s.sources ? s.sources.length : null,
          sites: s.sources ? uniqueSites(s.sources) : null,
        })),
    };
  });
  const ms = turn.done?.trace?.timings?.totalMs ?? (turn.endedAt ? turn.endedAt - turn.startedAt : null);
  return {
    memory: turn.memory && {
      count: turn.memory.hits.length,
      hits: turn.memory.hits.map((h) => ({ when: fmtDateTime(new Date(h.askedAt)), question: h.question })),
      empty: turn.memory.emptyRefs.map(labelOf),
    },
    steps,
    status: turn.status,
    stats: {
      recalled: turn.memory?.hits.length ?? 0,
      searches: turn.searches.length,
      sources: turn.done ? turn.done.sources.length : turn.sourceMap.size,
      ms,
    },
  };
}

/** Activity model for a stored assistant message, built from its trace. */
function storedView(message) {
  const t = message.trace;
  return {
    memory: t?.recall
      ? { count: t.recall.hits ?? 0, hits: null, empty: (t.recall.emptyRefs ?? []).map(labelOf) }
      : null,
    steps: (t?.steps ?? []).map((s) => ({
      preamble: null,
      searches: [{ queries: s.queries ?? [], pending: false, sourceCount: s.sources ?? 0, sites: null }],
    })),
    status: null,
    stats: {
      recalled: t?.recall?.hits ?? 0,
      searches: t?.steps?.length ?? 0,
      sources: message.sources?.length ?? 0,
      ms: t?.timings?.totalMs ?? null,
    },
  };
}

function summaryLine({ recalled, searches, sources, ms }) {
  const parts = [];
  if (recalled) parts.push(`Recalled ${recalled}`);
  if (searches) parts.push(`Searched ${searches}×`);
  if (sources) parts.push(plural(sources, 'source'));
  if (!parts.length) parts.push('Answered directly');
  if (ms !== null && ms !== undefined) parts.push(fmtSecs(ms));
  return parts.join(' · ');
}

/* ============================================================
 * sidebar
 * ============================================================ */

async function refreshSidebar() {
  try {
    state.conversations = await api.conversations();
    state.conversationsLoaded = true;
    renderSidebar();
    paintExampleOffer();
    // The title is written after the answer, so the header catches up here.
    const active = state.conversations.find((c) => c.id === state.conversationId);
    if (active?.title) setHeader(active.title);
  } catch {
    dom.convList.replaceChildren(el('p', { class: 'muted small pad' }, "Couldn't load conversations."));
  }
}

/** Titles are generated asynchronously, so refresh once more shortly after a turn. */
function scheduleSidebarRefresh() {
  refreshSidebar();
  setTimeout(refreshSidebar, 4000);
}

function renderSidebar() {
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const groups = new Map();
  for (const conv of state.conversations) {
    const day = new Date(conv.updatedAt);
    const key = dayKey(day);
    const label = key === today ? 'Today' : key === yesterday ? 'Yesterday' : fmtDay(day);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(conv);
  }

  const nodes = [];
  if (!state.conversations.length) nodes.push(el('p', { class: 'muted small pad' }, 'No conversations yet.'));
  for (const [label, convs] of groups) {
    nodes.push(el('h2', { class: 'group-heading' }, label));
    nodes.push(el('ul', { class: 'conv-group' }, convs.map(convItem)));
  }
  dom.convList.replaceChildren(...nodes);
  dom.forgetAll.hidden = !state.conversations.length;
  setActiveInSidebar(state.conversationId);
}

function convItem(conv) {
  const name = conv.title || 'Untitled';
  const link = el(
    'a',
    { class: 'conv-link', href: `#c=${encodeURIComponent(conv.id)}` },
    el('span', { class: 'conv-title' }, name),
    el('span', { class: 'conv-time' }, fmtTime(new Date(conv.updatedAt))),
  );
  link.addEventListener('click', closeNav);

  const del = el(
    'button',
    { type: 'button', class: 'conv-del', 'aria-label': `Delete ${name}`, title: 'Delete conversation' },
    '×',
  );
  del.addEventListener('click', () => deleteConversation(conv));

  return el('li', { class: 'conv-item', dataset: { id: conv.id } }, link, del);
}

function setActiveInSidebar(id) {
  for (const item of dom.convList.querySelectorAll('.conv-item')) {
    const active = id !== null && item.dataset.id === id;
    item.classList.toggle('active', active);
    const link = item.querySelector('.conv-link');
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function deleteConversation(conv) {
  const name = conv.title || 'Untitled';
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await api.remove(conv.id);
  } catch (err) {
    alert(`Couldn't delete this conversation. ${err.message}`);
    return;
  }
  if (conv.id === state.conversationId) newChat();
  await refreshSidebar();
}

async function forgetEverything() {
  if (!confirm('Delete every conversation since remembers? This cannot be undone.')) return;
  try {
    await api.removeAll();
  } catch (err) {
    alert(`Couldn't delete your memory. ${err.message}`);
    return;
  }
  newChat();
  await refreshSidebar();
}

function setNav(open) {
  document.body.classList.toggle('nav-open', open);
  dom.menuBtn.setAttribute('aria-expanded', String(open));
}

function closeNav() {
  setNav(false);
}

/* ============================================================
 * rendering: header, activity panel, answer, sources, meta, verification, errors
 * ============================================================ */

function setHeader(text) {
  dom.title.textContent = text;
  document.title = `${text} · since`;
}

/** Copies text and confirms on the button itself, so nothing else on screen moves. */
async function copyText(text, button) {
  // The label is kept from the first click: read on a second click, it would be "Copied" for good.
  button.dataset.label ??= button.textContent;
  clearTimeout(Number(button.dataset.timer));
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    // No clipboard permission (or an insecure context): say so rather than fail silently.
    button.textContent = 'Select to copy';
  }
  button.dataset.timer = String(
    setTimeout(() => {
      button.textContent = button.dataset.label;
    }, 1400),
  );
}

/** Puts a past message back in the composer, so it can be sent again with changes. */
function editMessage(text) {
  dom.input.value = text;
  autosize();
  updateSendState();
  dom.input.focus();
  dom.input.setSelectionRange(text.length, text.length);
}

function actionRow(...buttons) {
  return el('div', { class: 'msg-actions' }, buttons);
}

function userBubble(text) {
  const copy = el('button', { type: 'button', class: 'msg-action', title: 'Copy this message' }, 'Copy');
  copy.addEventListener('click', () => copyText(text, copy));
  const edit = el('button', { type: 'button', class: 'msg-action', title: 'Edit this message and send it again' }, 'Edit');
  edit.addEventListener('click', () => editMessage(text));
  return el(
    'div',
    { class: 'msg user' },
    el('div', { class: 'user-wrap' }, el('div', { class: 'bubble' }, text), actionRow(copy, edit)),
  );
}

/** Every piece of an assistant message, in display order. Live and stored turns share it. */
function assistantShell() {
  const parts = {
    activity: makeActivity(),
    thinking: el('div', { class: 'thinking' }, 'Thinking…'),
    answer: el('div', { class: 'answer' }),
    stopped: el('p', { class: 'stopped-note', hidden: true }, '(stopped)'),
    sources: el('div'),
    meta: el('div'),
    verify: el('div', { class: 'verify-slot' }),
    error: el('div'),
  };
  // Reads the rendered answer at click time, so it works the same for a live and a stored turn.
  const copy = el('button', { type: 'button', class: 'msg-action', title: 'Copy the answer' }, 'Copy');
  copy.addEventListener('click', () => copyText((parts.answer.innerText ?? '').trim(), copy));
  parts.actions = actionRow(copy);
  parts.actions.hidden = true;
  parts.root = el(
    'article',
    { class: 'msg assistant', 'aria-label': 'Assistant answer' },
    parts.activity.root,
    parts.thinking,
    parts.answer,
    parts.stopped,
    parts.sources,
    parts.meta,
    parts.verify,
    parts.actions,
    parts.error,
  );
  return parts;
}

/* Activity panel: a live list while the turn runs, collapsed to one summary line when done. */

function makeActivity() {
  const toggle = el('button', { type: 'button', class: 'activity-toggle', 'aria-expanded': 'false' });
  const body = el('div', { class: 'activity-body', 'aria-live': 'polite' });
  const root = el('div', { class: 'activity' }, toggle, body);
  const box = { root, toggle, body, expanded: false, collapsible: false, summary: '' };
  toggle.addEventListener('click', () => {
    box.expanded = !box.expanded;
    applyActivity(box);
  });
  return box;
}

function paintActivity(box, view, { collapsible, summary }) {
  box.collapsible = collapsible;
  box.summary = summary;
  box.body.replaceChildren(...activityNodes(view));
  applyActivity(box);
}

function applyActivity(box) {
  const hasRows = box.body.childNodes.length > 0;
  box.toggle.hidden = !box.collapsible;
  box.toggle.disabled = !hasRows;
  box.toggle.textContent = box.summary;
  box.toggle.setAttribute('aria-expanded', String(box.expanded && hasRows));
  box.body.hidden = box.collapsible && !box.expanded;
  box.root.hidden = !box.collapsible && !hasRows;
}

function activityNodes(view) {
  const nodes = [];
  const m = view.memory;
  if (m) {
    if (m.count > 0) {
      nodes.push(el('div', { class: 'act-row' }, el('span', { class: 'act-label' }, `Recalled ${plural(m.count, 'earlier exchange', 'earlier exchanges')}`)));
      if (m.hits) {
        nodes.push(
          el(
            'ul',
            { class: 'recall-hits' },
            m.hits.map((h) => el('li', null, el('span', { class: 'when' }, h.when), ` — “${truncate(h.question, 90)}”`)),
          ),
        );
      }
    }
    for (const label of m.empty) nodes.push(el('div', { class: 'muted small' }, `No conversations on ${label}`));
  }
  for (const step of view.steps) {
    if (step.preamble) nodes.push(el('p', { class: 'preamble' }, step.preamble));
    for (const s of step.searches) nodes.push(...searchRows(s));
  }
  if (view.status) nodes.push(el('div', { class: 'status-line' }, view.status));
  return nodes;
}

function searchRows(s) {
  const rows = [];
  if (s.queries.length || s.pending) {
    rows.push(
      el(
        'div',
        { class: 'act-row' },
        el('span', { class: s.pending ? 'act-label pending' : 'act-label' }, s.pending ? 'Searching' : 'Searched'),
        s.queries.map(queryPill),
      ),
    );
  }
  if (s.sourceCount !== null && s.sourceCount !== undefined) {
    rows.push(
      el(
        'div',
        { class: 'act-row' },
        el('span', { class: 'act-label' }, `Found ${plural(s.sourceCount, 'source')}`),
        s.sites?.length ? el('span', { class: 'muted' }, s.sites.join(', ')) : null,
      ),
    );
  }
  return rows;
}

function queryPill(q) {
  return el(
    'span',
    { class: 'pill' },
    q.q,
    q.after ? el('span', { class: 'badge' }, `after ${fmtDateOnly(q.after)}`) : null,
    q.site ? el('span', { class: 'badge' }, `site ${q.site}`) : null,
  );
}

function paintLiveActivity(turn) {
  const view = liveView(turn);
  paintActivity(turn.parts.activity, view, {
    collapsible: Boolean(turn.done || turn.finished),
    summary: summaryLine(view.stats),
  });
}

/* Answer */

function renderMarkdown(text) {
  // "~$146" means "about $146", but GFM reads two single tildes as strikethrough. Escape a lone
  // tilde in front of a number or currency sign; "~~deleted~~" still works.
  const prepared = text.replace(/(^|[^~\\])~(?=[\d$€£¥≈])/g, '$1\\~');
  const html = marked.parse(prepared, { gfm: true, breaks: true, async: false });
  return DOMPurify.sanitize(String(html), PURIFY);
}

// Answers are model output written from web pages, so they get text, links and tables only.
// No images or media in particular: those load without a click, and their URL could carry
// anything the model was led to put in it (the page's CSP blocks them too).
const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta'],
  FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'background', 'poster'],
};

function wrapTables(root) {
  for (const table of root.querySelectorAll('table')) {
    if (table.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = el('div', { class: 'table-wrap' });
    table.replaceWith(wrap);
    wrap.append(table);
  }
}

function setAnswer(parts, text, lookup) {
  // Nothing to copy until there is an answer.
  if (parts.actions) parts.actions.hidden = !text;
  if (!text) {
    parts.answer.replaceChildren();
    return;
  }
  parts.answer.innerHTML = renderMarkdown(text);
  wrapTables(parts.answer);
  applyCitations(parts.answer, lookup);
}

function paintLiveAnswer(turn) {
  const text = answerText(turn);
  setAnswer(turn.parts, text, makeLookup(turn.sourceMap));
  turn.parts.thinking.hidden = Boolean(text) || turn.finished || turn.stopped || Boolean(turn.error);
  turn.parts.stopped.hidden = !turn.stopped;
}

/* Sources list */

/** Six cards cover most answers; the rest wait behind a toggle so long checks stay readable. */
const SOURCES_SHOWN = 6;

function paintSources(parts, sources) {
  parts.sources.replaceChildren();
  if (!sources.length) return;
  const list = el('ol', { class: 'sources', 'aria-label': 'Sources' }, sources.map(sourceCard));
  parts.sources.append(list);
  if (sources.length <= SOURCES_SHOWN) return;
  const extra = [...list.children].slice(SOURCES_SHOWN);
  for (const li of extra) li.hidden = true;
  const toggle = el('button', { type: 'button', class: 'link-btn sources-more' }, `Show all ${sources.length} sources`);
  toggle.addEventListener('click', () => {
    const show = extra[0].hidden;
    for (const li of extra) li.hidden = !show;
    toggle.textContent = show ? 'Show fewer sources' : `Show all ${sources.length} sources`;
  });
  parts.sources.append(toggle);
}

function sourceCard(s) {
  const meta = [s.site, fmtDateOnly(s.published)].filter(Boolean).join(' · ');
  return el(
    'li',
    { class: 'source' },
    el(
      'a',
      { class: 'source-title', href: safeHref(s.url), target: '_blank', rel: 'noopener' },
      el('span', { class: 'src-n' }, `[${s.n}] `),
      s.title || s.url,
    ),
    meta ? el('div', { class: 'src-meta' }, meta) : null,
  );
}

/* Meta row and details */

function paintMeta(parts, trace) {
  parts.meta.replaceChildren();
  if (!trace) return;
  const timings = trace.timings ?? {};
  const steps = trace.steps?.length ?? 0;
  const bits = [fmtSecs(timings.totalMs)];
  if (timings.firstTokenMs !== null && timings.firstTokenMs !== undefined) {
    bits.push(`first token ${fmtSecs(timings.firstTokenMs)}`);
  }
  bits.push(steps === 1 ? '1 search' : `${steps} searches`);
  if ((timings.thinkingMs ?? 0) >= 500) bits.push(`thought ${fmtSecs(timings.thinkingMs)}`);

  const details = el(
    'pre',
    { class: 'details', hidden: true },
    JSON.stringify(
      { model: trace.model, effort: trace.effort, searchRounds: trace.searchRounds, timings, usage: trace.usage, recall: trace.recall, steps: trace.steps },
      null,
      2,
    ),
  );
  const toggle = el('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false' }, 'Details');
  toggle.addEventListener('click', () => {
    details.hidden = !details.hidden;
    toggle.setAttribute('aria-expanded', String(!details.hidden));
  });
  parts.meta.append(el('div', { class: 'meta-row' }, el('span', null, bits.join(' · ')), toggle), details);
}

/* Verification badge */

function setVerifyPending(parts) {
  parts.verify.replaceChildren(el('span', { class: 'muted small' }, 'Checking citations…'));
}

const GROUNDING_HOW =
  'Each figure in a cited claim was looked for in the passages of the source it cites. ' +
  'A total worked out from them, such as a seat price times your team size, counts when the sum comes out. ' +
  "It runs on every answer, with no model: it catches a figure that isn't on the page or doesn't add up, not a misreading of one that is.";

function paintVerification(slot, v) {
  slot.replaceChildren();
  if (!v) return;
  const grounding = v.verifier === 'grounding';
  if (v.status === 'skipped') {
    slot.append(el('span', { class: 'muted small' }, 'Citation check skipped'));
    return;
  }
  if (v.status === 'error') {
    slot.append(el('span', { class: 'verify-badge', title: v.error ?? '' }, 'Citation check unavailable'));
    return;
  }
  if (grounding && v.cited === 0) {
    slot.append(el('span', { class: 'muted small', title: GROUNDING_HOW }, 'Grounding check: no cited figures to check'));
    return;
  }
  const flagged = v.flagged ?? [];
  const worked = grounding ? (v.worked ?? []) : [];
  const good = v.cited > 0 && v.supported === v.cited;
  const panel = el(
    'div',
    { class: 'flagged', hidden: true },
    grounding ? el('p', { class: 'how' }, GROUNDING_HOW) : null,
    el('ul', null, flagged.length ? flagged.map(flaggedItem) : el('li', { class: 'muted' }, 'No flagged claims.')),
    worked.length ? el('p', { class: 'how worked-head' }, 'Worked out from the cited figures:') : null,
    worked.length ? el('ul', { class: 'worked' }, worked.map(workedItem)) : null,
  );
  const label = grounding
    ? `Grounding check: ${v.supported}/${v.cited} grounded`
    : `Citations checked: ${v.supported}/${v.cited} supported`;
  const badge = el(
    'button',
    { type: 'button', class: `verify-badge ${good ? 'good' : 'warn'}`, 'aria-expanded': 'false' },
    label,
  );
  badge.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    badge.setAttribute('aria-expanded', String(!panel.hidden));
  });
  slot.append(badge, panel);
}

function workedItem(w) {
  const cites = w.source ? ` [${w.source.split(', ').join('][')}]` : '';
  return el('li', null, `${w.figure} ${w.how}`, el('span', { class: 'muted' }, cites));
}

function flaggedItem(f) {
  return el(
    'li',
    null,
    el('span', { class: 'verdict' }, String(f.verdict).replace(/_/g, ' ')),
    ' ',
    el('span', null, f.claim),
    f.note ? el('div', { class: 'note' }, f.note) : null,
  );
}

/* Errors with retry */

function paintError(turn) {
  const slot = turn.parts.error;
  slot.replaceChildren();
  if (!turn.error) return;
  const retry = el('button', { type: 'button', class: 'retry' }, 'Retry');
  retry.addEventListener('click', () => retryTurn(turn));
  slot.append(el('div', { class: 'turn-error', role: 'alert' }, el('span', null, turn.error), retry));
}

/* Stored messages (opening an existing conversation) */

function renderStoredAssistant(message) {
  const parts = assistantShell();
  const trace = message.trace;
  const view = storedView(message);
  paintActivity(parts.activity, view, {
    collapsible: Boolean(trace),
    summary: summaryLine(view.stats),
  });
  parts.thinking.hidden = true;
  setAnswer(parts, message.content, makeLookup(new Map((message.sources ?? []).map((s) => [s.n, s]))));
  paintSources(parts, message.sources ?? []);
  paintMeta(parts, trace);
  if (message.verification) paintVerification(parts.verify, message.verification);
  return parts.root;
}

function renderMessage(message) {
  return message.role === 'user' ? userBubble(message.content) : renderStoredAssistant(message);
}

/* ============================================================
 * citations: [n] markers become superscript chips linking to the source
 * ============================================================ */

const CITE_MARKER = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/** Lookup order: this turn's sources first, then sources cited earlier in the conversation. */
function makeLookup(local) {
  return (n) => local.get(n) ?? state.convSources.get(n) ?? null;
}

function citeChip(n, src) {
  return el(
    'a',
    {
      class: 'cite',
      href: safeHref(src.url),
      target: '_blank',
      rel: 'noopener',
      title: [src.title, src.site].filter(Boolean).join(' — '),
    },
    String(n),
  );
}

/** Replaces markers in text nodes (outside code, pre and links). Markers with any unknown n stay as text. */
function applyCitations(root, lookup) {
  const textNodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue.includes('[') && !node.parentElement.closest('code, pre, a')) textNodes.push(node);
  }

  for (const node of textNodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let changed = false;
    for (const m of text.matchAll(CITE_MARKER)) {
      const nums = m[1].split(',').map((s) => Number(s.trim()));
      const sources = nums.map((n) => lookup(n));
      if (sources.some((s) => !s)) continue;
      frag.append(text.slice(last, m.index));
      nums.forEach((n, i) => frag.append(citeChip(n, sources[i])));
      last = m.index + m[0].length;
      changed = true;
    }
    if (changed) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
}

/* ============================================================
 * turn lifecycle: streaming, events, stop, retry
 * ============================================================ */

function markDirty(turn, what) {
  turn.dirty[what] = true;
  if (!turn.raf) turn.raf = requestAnimationFrame(() => flushTurn(turn));
}

/** Paints a turn once per frame. Skipped for turns whose DOM is no longer on screen. */
function flushTurn(turn) {
  turn.raf = 0;
  const { answer, activity } = turn.dirty;
  turn.dirty = { answer: false, activity: false };
  if (!turn.parts.root.isConnected) return;
  const follow = isNearBottom();
  if (activity) paintLiveActivity(turn);
  if (answer) paintLiveAnswer(turn);
  if (follow) scrollThreadToBottom();
}

function onEvent(turn, ev) {
  if (turn.stopped) return;
  switch (ev.type) {
    case 'start': {
      turn.conversationId = ev.conversationId;
      if (state.conversationId !== ev.conversationId) {
        state.conversationId = ev.conversationId;
        setHeader('Untitled');
        setHash(ev.conversationId);
      }
      break;
    }
    case 'memory':
      turn.memory = { hits: ev.hits ?? [], emptyRefs: ev.emptyRefs ?? [] };
      markDirty(turn, 'activity');
      break;
    case 'status':
      turn.status = ev.text;
      markDirty(turn, 'activity');
      break;
    case 'search':
      turn.searches.push({ step: ev.step, queries: ev.queries ?? [], sources: null });
      markDirty(turn, 'activity');
      markDirty(turn, 'answer');
      break;
    case 'sources': {
      let search = [...turn.searches].reverse().find((s) => s.step === ev.step);
      if (!search) {
        search = { step: ev.step, queries: [], sources: null };
        turn.searches.push(search);
      }
      search.sources = ev.sources ?? [];
      for (const src of search.sources) turn.sourceMap.set(src.n, src);
      markDirty(turn, 'activity');
      markDirty(turn, 'answer');
      break;
    }
    case 'token': {
      turn.texts.set(ev.step, (turn.texts.get(ev.step) ?? '') + ev.text);
      markDirty(turn, 'answer');
      if (ev.step < maxStep(turn)) markDirty(turn, 'activity'); // text before a search is a preamble
      break;
    }
    case 'done': {
      turn.done = ev;
      for (const src of ev.sources ?? []) {
        turn.sourceMap.set(src.n, src);
        state.convSources.set(src.n, src);
      }
      if (ev.title && state.conversationId === turn.conversationId) setHeader(ev.title);
      paintSources(turn.parts, ev.sources ?? []);
      paintMeta(turn.parts, ev.trace);
      if (state.health.upheld) {
        turn.verifying = true;
        setVerifyPending(turn.parts);
      }
      markDirty(turn, 'answer');
      markDirty(turn, 'activity');
      scheduleSidebarRefresh();
      break;
    }
    case 'verification':
      turn.verifying = false;
      paintVerification(turn.parts.verify, ev.verification);
      break;
    case 'error':
      turn.error = ev.message || 'Something went wrong.';
      paintError(turn);
      break;
    default:
      break;
  }
}

async function streamTurn(turn) {
  const controller = new AbortController();
  turn.controller = controller;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ conversationId: turn.conversationId ?? undefined, message: turn.message, tz: TZ }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(await errorFrom(res));
    await readEvents(res.body, (ev) => onEvent(turn, ev));
  } catch (err) {
    if (!controller.signal.aborted && !turn.error) {
      turn.error = err instanceof TypeError ? "Couldn't reach the server." : err.message;
    }
  }
  finishTurn(turn);
}

function finishTurn(turn) {
  if (turn.finished) return;
  turn.finished = true;
  turn.endedAt = performance.now();
  if (!turn.done && !turn.stopped && !turn.error) {
    turn.error = 'The connection closed before the answer finished.';
  }
  if (turn.verifying) {
    turn.verifying = false;
    turn.parts.verify.replaceChildren();
  }
  if (turn.raf) cancelAnimationFrame(turn.raf);
  turn.raf = 0;
  turn.dirty = { answer: true, activity: true };
  flushTurn(turn);
  paintError(turn);
  if (state.activeTurn === turn) {
    state.activeTurn = null;
    setBusy(false);
  }
  // A completed turn already refreshed the sidebar on its `done` event.
  if (turn.conversationId && !turn.done) scheduleSidebarRefresh();
}

/** Starts a turn: user bubble (unless retrying), assistant shell, then the stream. */
function startTurn({ message, conversationId = state.conversationId, retryOf = null }) {
  if (state.activeTurn) return;
  for (const btn of dom.threadInner.querySelectorAll('.retry')) btn.disabled = true;
  if (dom.threadInner.querySelector('.empty')) dom.threadInner.replaceChildren();

  let userEl;
  if (retryOf) {
    userEl = retryOf.userEl;
    retryOf.parts.root.remove();
  } else {
    userEl = userBubble(message);
    dom.threadInner.append(userEl);
  }

  const turn = newTurn({ message, conversationId, userEl });
  turn.parts = assistantShell();
  dom.threadInner.append(turn.parts.root);
  state.activeTurn = turn;
  setBusy(true);
  paintLiveActivity(turn);
  paintLiveAnswer(turn);
  scrollThreadToBottom();
  streamTurn(turn);
}

function retryTurn(turn) {
  if (state.activeTurn) return;
  startTurn({ message: turn.message, conversationId: turn.conversationId, retryOf: turn });
}

/** Aborts the streaming turn, if any. Its partial answer stays on screen marked "(stopped)". */
function abortActive() {
  const turn = state.activeTurn;
  if (!turn) return;
  state.activeTurn = null;
  turn.stopped = true;
  turn.controller?.abort();
  setBusy(false);
}

/* ============================================================
 * composer
 * ============================================================ */

function setBusy(busy) {
  dom.send.textContent = busy ? 'Stop' : 'Send';
  dom.send.classList.toggle('stop', busy);
  dom.send.setAttribute('aria-label', busy ? 'Stop generating' : 'Send message');
  updateSendState();
}

function updateSendState() {
  dom.send.disabled = !state.activeTurn && !dom.input.value.trim();
}

function autosize() {
  dom.input.style.height = 'auto';
  dom.input.style.height = `${dom.input.scrollHeight}px`;
}

function wireComposer() {
  dom.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.activeTurn) {
      abortActive();
      return;
    }
    const text = dom.input.value.trim();
    if (!text) return;
    dom.input.value = '';
    autosize();
    updateSendState();
    startTurn({ message: text });
  });

  dom.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!state.activeTurn) dom.form.requestSubmit();
    }
  });

  dom.input.addEventListener('input', () => {
    autosize();
    updateSendState();
  });
}

/* ============================================================
 * thread: scrolling, empty state, opening conversations
 * ============================================================ */

function isNearBottom() {
  const t = dom.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < NEAR_BOTTOM_PX;
}

function scrollThreadToBottom() {
  dom.thread.scrollTop = dom.thread.scrollHeight;
}

function renderEmpty() {
  const chips = EXAMPLES.map((text) => {
    const chip = el('button', { type: 'button', class: 'chip' }, text);
    chip.addEventListener('click', () => startTurn({ message: text, conversationId: null }));
    return chip;
  });
  dom.threadInner.replaceChildren(
    el(
      'section',
      { class: 'empty' },
      el('p', { class: 'empty-lead' }, 'Ask anything. I search the web, cite sources, and remember our past conversations by date.'),
      // The offer comes first: without history, the example questions about memory can't work.
      el('div', { class: 'offer-slot' }),
      el('div', { class: 'chips' }, chips),
    ),
  );
  paintExampleOffer();
}

/**
 * While memory is empty, offer three real past conversations (backdated to last Tuesday,
 * last Monday and 3 November), so the memory questions can be tried straight away.
 */
function paintExampleOffer() {
  const slot = dom.threadInner.querySelector('.offer-slot');
  if (!slot) return;
  const current = slot.querySelector('.example-offer');
  if (current?.dataset.done) return;
  slot.replaceChildren();
  if (!state.conversationsLoaded || state.conversations.length) return;

  const button = el('button', { type: 'button', class: 'example-btn' }, 'Add example history');
  const offer = el(
    'div',
    { class: 'example-offer' },
    el(
      'p',
      { class: 'muted small' },
      'Memory needs something to remember. Add three real conversations — last Tuesday, last Monday and 3 November — then ask what has changed since.',
    ),
    button,
  );
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Adding three conversations… about 15 s';
    offer.querySelector('.turn-error')?.remove();
    try {
      const res = await fetch('/api/example-history', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tz: TZ }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      offer.dataset.done = '1';
      offer.replaceChildren(el('p', { class: 'muted small' }, 'Added. They are in the sidebar: ask about them with the first two questions below.'));
      await refreshSidebar();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Add example history';
      offer.append(el('p', { class: 'turn-error small', role: 'alert' }, err.message));
    }
  });
  slot.append(offer);
}

function setHash(id) {
  const next = `c=${encodeURIComponent(id)}`;
  if (location.hash !== `#${next}`) location.hash = next;
}

let openSeq = 0;

async function openConversation(id) {
  abortActive();
  const seq = ++openSeq;
  state.conversationId = id;
  state.convSources = new Map();
  setActiveInSidebar(id);
  setHeader('Loading…');
  dom.threadInner.replaceChildren(el('p', { class: 'muted center' }, 'Loading conversation…'));
  closeNav();

  try {
    const { conversation, messages } = await api.conversation(id);
    if (seq !== openSeq) return;
    for (const m of messages) {
      for (const s of m.sources ?? []) state.convSources.set(s.n, s);
    }
    setHeader(conversation.title || 'Untitled');
    dom.threadInner.replaceChildren(...messages.map(renderMessage));
    scrollThreadToBottom();
  } catch (err) {
    if (seq !== openSeq) return;
    setHeader('Untitled');
    dom.threadInner.replaceChildren(
      el('div', { class: 'turn-error', role: 'alert' }, `Couldn't open this conversation. ${err.message}`),
    );
  }
}

function newChat() {
  abortActive();
  openSeq++;
  state.conversationId = null;
  state.convSources = new Map();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  setHeader('New chat');
  renderEmpty();
  setActiveInSidebar(null);
  closeNav();
  if (matchMedia('(min-width: 760px)').matches) dom.input.focus();
}

function onHashChange() {
  const id = hashId();
  if (id === state.conversationId) return;
  if (!id) {
    newChat();
    return;
  }
  openConversation(id);
}

/* ============================================================
 * init
 * ============================================================ */

function wireChrome() {
  dom.newChat.addEventListener('click', newChat);
  dom.forgetAll.addEventListener('click', forgetEverything);
  dom.menuBtn.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
  dom.scrim.addEventListener('click', closeNav);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
  window.addEventListener('hashchange', onHashChange);
}

async function init() {
  wireChrome();
  wireComposer();
  updateSendState();

  const healthReady = api
    .health()
    .then((h) => {
      state.health = { ...state.health, ...h, ok: true };
    })
    .catch(() => {});
  refreshSidebar();
  await healthReady;

  const id = hashId();
  if (id) {
    openConversation(id);
  } else {
    setHeader('New chat');
    renderEmpty();
  }
}

init();
