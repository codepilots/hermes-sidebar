const $ = id => document.getElementById(id);
const log = $('log'), q = $('q'), inc = $('inc'), form = $('f'), sendBtn = $('send'), empty = $('empty');
const MAX = 60000;
const SYSTEM = 'The user is asking from a Chromium sidebar about the web page they are reading. Page context is attached to their messages. Be concise. Replies render as GitHub-flavoured Markdown in a narrow panel: use headings, bullet and numbered lists, task lists, tables, block quotes, links and fenced code blocks with a language tag where they help; prefer short tables (3-4 columns).';
const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_RETRY = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';

// Hermes keeps the conversation server-side under this id (X-Hermes-Session-Id);
// the outrigger connection binds to the same id so Hermes can call browser tools.
const newSessionId = () => 'sidebar-' + crypto.randomUUID();
let sessionId = newSessionId();
let controller = null, lastQuestion = '', currentOut = null;
// Outrigger platform: chat goes through Hermes's messaging pipeline (slash commands,
// /model, …) over the outrigger connection, when the gateway offers it.
const newChatId = () => 'c-' + crypto.randomUUID();
let chatId = newChatId();
let platformPref = true;      // settings: "Chat through the Outrigger platform"
let usingToken = false;       // key is an outrigger client token (otr_…): platform only
let platformBusy = false;     // a platform turn is in progress (typing/messages arriving)
let platformIdle = 0;         // timer that ends the busy state after a quiet spell
const platformMsgs = new Map(); // message_id -> { el, text }
let platformFill = null;      // the pending reply bubble the next chat.message fills
let pendingPage = new Map();  // client_msg_id -> page state to commit once accepted
const usePlatform = () => platformPref && outrigger.attached && outrigger.platformAvailable;
// "Allow <class> on <site>" grants for this conversation: "class|origin".
let grants = new Set();
// The page last attached in this conversation ({url, textHash, sel}). Hermes keeps the
// history, so an unchanged page is not sent again; a new tab, a changed page or a new
// selection is.
let lastSentPage = null;
let reviewerAuto = true;
chrome.storage.local.get('reviewerAuto').then(v => { reviewerAuto = v.reviewerAuto !== false; });

/* ---------- status ---------- */
function setStatus(kind, text) {
  const s = $('status'); s.className = 'status' + (kind ? ' ' + kind : ''); $('statusText').textContent = text;
}
async function checkKey() {
  const { key = '' } = await chrome.storage.local.get('key');
  if (!key) setStatus('warn', 'No API key — open settings'); else if (!controller) setStatus('', 'Ready');
}
checkKey();

/* ---------- browser tools (outrigger) ---------- */
const TOOL_LABEL = {
  attached: ['on', 'Browser tools on'],
  connecting: ['wait', 'Browser tools connecting…'],
  offline: ['bad', 'Browser tools offline'],
  off: ['off', 'Browser tools off'],
};
const outrigger = new Outrigger({
  tools: BROWSER_TOOLS,
  onCall: handleCall,
  onCancel: (id, reason) => pendingCards.get(id)?.cancel(reason),
  onChat: m => onChatFrame(m),
  onDoc: m => NB.onFrame(m),
  onWelcome: w => { if (w.platform?.available) { outrigger.chatAttach(chatId); outrigger.requestCommands(); } NB.reattach(); },
  onStatus: (state, detail) => {
    const [cls, text] = TOOL_LABEL[state] || TOOL_LABEL.off;
    const el = $('toolsState'); el.className = 'tools-state ' + cls; el.textContent = text;
    el.title = detail || (state === 'attached'
      ? 'Hermes can read pages and, with your approval, act in this browser'
      : state === 'off' ? 'Turn on in settings' : '');
  },
});

// Personal-data redaction settings (redactor.js). Tell Hermes it is on via hello, and
// only offer `reveal` when there is something to reveal.
async function loadRedaction() {
  const { redact = true, redactCats = {}, redactSkip = [] } = await chrome.storage.local.get(['redact', 'redactCats', 'redactSkip']);
  redactor.configure({ enabled: redact, cats: redactCats, skip: redactSkip });
  const granted = {};
  for (const perm of new Set(Object.values(OPTIONAL_TOOL_PERMISSION))) {
    try { granted[perm] = await chrome.permissions.contains({ permissions: [perm] }); } catch { granted[perm] = false; }
  }
  outrigger.tools = BROWSER_TOOLS.filter(t => (t.name !== 'reveal' || redact) &&
    (!OPTIONAL_TOOL_PERMISSION[t.name] || granted[OPTIONAL_TOOL_PERMISSION[t.name]]));
  outrigger.redaction = { enabled: redact, categories: redact ? redactor.categories() : [] };
}

async function syncOutrigger() {
  await loadRedaction();
  const { endpoint = DEFAULT_ENDPOINT, key = '', browserTools = true, platformChat = true } =
    await chrome.storage.local.get(['endpoint', 'key', 'browserTools', 'platformChat']);
  platformPref = platformChat;
  usingToken = /^otr_/.test(key);
  if (!key || !browserTools) return outrigger.stop();
  outrigger.start({ endpoint, key, sessionId });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  checkKey();
  if (changes.reviewerAuto) reviewerAuto = changes.reviewerAuto.newValue !== false;
  if (changes.endpoint || changes.key || changes.browserTools || changes.redact || changes.redactCats || changes.redactSkip || changes.personalToolsChanged) syncOutrigger();
  if (changes.platformChat) platformPref = changes.platformChat.newValue !== false;
});
syncOutrigger();

/* ---------- current tab card ---------- */
async function tab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
async function showTab() {
  const t = await tab(); if (!t) return;
  let host = ''; try { const u = new URL(t.url); host = u.protocol.startsWith('http') ? u.hostname.replace(/^www\./, '') : u.protocol.replace(':', ''); } catch {}
  $('pageTitle').textContent = t.title || t.url || 'Untitled';
  $('pageTitle').title = t.title || '';
  $('pageHost').textContent = host;
  const fav = $('favicon');
  fav.src = t.favIconUrl && /^https?:|^data:/.test(t.favIconUrl) ? t.favIconUrl : 'icons/icon-16.png';
  fav.onerror = () => { fav.onerror = null; fav.src = 'icons/icon-16.png'; };
  const summary = `active tab ${t.id}: "${(t.title || '').slice(0, 120)}" ${(t.url || '').slice(0, 160)}`;
  outrigger.setContext((await redactor.redact(summary, { url: t.url })).text);
}
chrome.tabs.onActivated.addListener(showTab);
chrome.tabs.onUpdated.addListener((i, c) => (c.title || c.favIconUrl || c.url) && showTab());
showTab();

const syncInc = () => $('pageCard').classList.toggle('off', !inc.checked);
inc.addEventListener('change', () => { syncInc(); chrome.storage.local.set({ includePage: inc.checked }); });
chrome.storage.local.get('includePage').then(v => { if (v.includePage === false) inc.checked = false; syncInc(); });

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

async function grab() {
  const t = await tab();
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => ({ sel: String(getSelection()), text: document.body ? document.body.innerText : '' }) });
    return { url: t.url, title: t.title, ...r.result };
  } catch (e) { return { url: t.url, title: t.title, text: '', sel: '', err: e.message }; }
}

/* ---------- rendering ---------- */
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
const toBottom = (force) => { if (force || nearBottom()) log.scrollTop = log.scrollHeight; };

const redactedNote = found => found.map(f => `${f.ph}  ${f.value}`).join('\n');

function addUser(text, tag, found = []) {
  empty.hidden = true;
  const d = document.createElement('div'); d.className = 'msg user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  if (found.length) tag = (tag ? tag + ' · ' : '') + `🛡 ${found.length} redacted`;
  if (tag) {
    const t = document.createElement('span'); t.className = 'ctx-tag'; t.textContent = tag;
    if (found.length) t.title = 'Hidden from Hermes (shown only here):\n' + redactedNote(found);
    b.appendChild(t);
  }
  d.appendChild(b); log.appendChild(d); toBottom(true);
}

function addAssistant() {
  empty.hidden = true;
  const d = document.createElement('div'); d.className = 'msg assistant';
  d.innerHTML = '<div class="who"><img src="icons/icon-16.png" alt="">Hermes</div><div class="calls"></div><div class="body"><span class="typing"><i></i><i></i><i></i></span></div><div class="tools"></div>';
  log.appendChild(d); toBottom(true);
  return d;
}

function renderInto(msgEl, text, streaming) {
  const body = msgEl.querySelector('.body');
  const stick = nearBottom();
  body.innerHTML = renderMarkdown(text);
  redactor.rehydrate(body);  // the user sees real values; Hermes only had placeholders
  if (streaming) { const last = body.lastElementChild; (last && !last.classList.contains('code') ? last : body).classList.add('caret'); }
  if (stick) log.scrollTop = log.scrollHeight;
}

function addTools(msgEl, text, retry) {
  const tools = msgEl.querySelector('.tools'); tools.innerHTML = '';
  if (text) {
    const c = document.createElement('button'); c.className = 'icon-btn'; c.title = 'Copy response'; c.innerHTML = ICON_COPY;
    c.onclick = async () => { await navigator.clipboard.writeText(redactor.unredact(text)); c.innerHTML = ICON_OK; setTimeout(() => c.innerHTML = ICON_COPY, 1200); };
    tools.appendChild(c);
  }
  if (retry) {
    const r = document.createElement('button'); r.className = 'icon-btn'; r.title = 'Retry'; r.innerHTML = ICON_RETRY;
    r.onclick = () => { msgEl.remove(); const us = log.querySelectorAll('.msg.user'); if (us.length) us[us.length - 1].remove(); q.value = lastQuestion; send(); };
    tools.appendChild(r);
  }
}

// copy buttons on code blocks (delegated)
log.addEventListener('click', async e => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  await navigator.clipboard.writeText(b.closest('.code').querySelector('code').textContent);
  b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200);
});

/* ---------- tool calls from Hermes ---------- */
const pendingCards = new Map(); // call_id -> { cancel(reason) }

// Where tool activity shows: inside the reply being streamed, or on its own when
// the call comes from a turn this panel did not start.
function callsContainer() {
  if (currentOut && currentOut.isConnected) return currentOut.querySelector('.calls');
  empty.hidden = true;
  const d = document.createElement('div'); d.className = 'msg assistant';
  d.innerHTML = '<div class="who"><img src="icons/icon-16.png" alt="">Hermes</div><div class="calls"></div>';
  log.appendChild(d);
  return d.querySelector('.calls');
}

function summarizeArgs(tool, args) {
  if (args.fields) return `${args.fields.length} field${args.fields.length === 1 ? '' : 's'}`;
  if (args.ref) return args.ref;
  if (args.text && tool === 'wait_for') return `"${args.text}"`;
  if (args.to) return args.to;
  if (args.selector) return args.selector;
  if (args.url) return args.url;
  if (Number.isInteger(args.tab)) return 'tab ' + args.tab;
  return '';
}

function activityLine(tool, args) {
  const line = document.createElement('div'); line.className = 'call-line running';
  const name = document.createElement('span'); name.className = 'call-name'; name.textContent = tool;
  const what = document.createElement('span'); what.className = 'call-what'; what.textContent = summarizeArgs(tool, args);
  const st = document.createElement('span'); st.className = 'call-st'; st.textContent = '…';
  line.append(name, what, st);
  callsContainer().appendChild(line); toBottom();
  return {
    done(ok, note) { line.className = 'call-line ' + (ok ? 'ok' : 'bad'); st.textContent = ok ? '✓' : '✕'; if (note) st.title = note; },
    via(text, title) { const v = document.createElement('span'); v.className = 'call-via'; v.textContent = text; if (title) v.title = title; line.insertBefore(v, st); },
  };
}

// Allow / Deny card for "confirm" tools. Resolves 'allow' | 'grant' | 'deny' | 'cancelled'.
function confirmCard(m, targetText, origin) {
  return new Promise(resolve => {
    const flagged = m.review?.verdict === 'deny';
    const card = document.createElement('div'); card.className = 'confirm' + (flagged ? ' flagged' : '');
    const head = document.createElement('div'); head.className = 'confirm-head';
    head.textContent = `Hermes wants to ${m.tool === 'run_js' ? 'run code' : m.tool.replace('_', ' ')}`;
    const where = document.createElement('div'); where.className = 'confirm-where'; where.textContent = targetText;
    const pre = document.createElement('pre'); pre.className = 'confirm-args';
    pre.textContent = m.cardText || (m.tool === 'run_js' ? m.args.code : JSON.stringify(m.args, null, 2));
    const parts = [head, where];
    if (m.review && m.review.reason) {
      const rv = document.createElement('div'); rv.className = 'confirm-review ' + m.review.verdict;
      rv.textContent = ({ approve: 'Reviewer: looks fine — ', escalate: 'Reviewer: check this — ',
                          deny: 'Reviewer flagged this — ' })[m.review.verdict] + m.review.reason;
      parts.push(rv);
    }
    if (m.piiUsed && m.piiUsed.length) {
      const pv = document.createElement('div'); pv.className = 'confirm-review pii-use';
      pv.textContent = `🛡 Uses ${m.piiUsed.length} redacted value${m.piiUsed.length === 1 ? '' : 's'} (${m.piiUsed.join(', ')}); ` +
        'allowing sends the real value to this site.';
      parts.push(pv);
    }
    const row = document.createElement('div'); row.className = 'confirm-row';
    const allow = document.createElement('button'); allow.className = 'btn-allow'; allow.textContent = 'Allow';
    const buttons = [allow];
    let grant = null;
    const cls = TOOL_CLASS[m.tool];
    // No site-wide grant from a flagged card (this one call only), nor for classes that
    // reach beyond one site (history and bookmarks).
    if (cls && origin && !flagged && !NO_GRANT_CLASSES.has(cls)) {
      grant = document.createElement('button'); grant.className = 'btn-grant';
      grant.textContent = `Allow ${CLASS_LABEL[cls]} on ${hostOf(origin)}`;
      grant.title = 'For the rest of this conversation. Starting a new conversation clears it.';
      buttons.push(grant);
    }
    const deny = document.createElement('button'); deny.className = 'btn-deny'; deny.textContent = 'Deny';
    buttons.push(deny);
    const note = document.createElement('span'); note.className = 'confirm-note';
    row.append(...buttons, note);
    card.append(...parts, pre, row);
    callsContainer().appendChild(card); toBottom(true);
    allow.focus();

    let settled = false;
    const finish = (verdict, text) => {
      if (settled) return; settled = true;
      clearTimeout(timer); pendingCards.delete(m.call_id);
      buttons.forEach(b => b.disabled = true);
      card.classList.add('done', verdict);
      note.textContent = text;
      resolve(verdict);
    };
    allow.onclick = () => finish('allow', 'Allowed');
    if (grant) grant.onclick = () => finish('grant', `Allowed ${CLASS_LABEL[cls]} on ${hostOf(origin)}`);
    deny.onclick = () => finish('deny', 'Denied');
    const timer = setTimeout(() => finish('cancelled', 'Timed out'), Math.max(1000, m.deadline_ms - 1000));
    pendingCards.set(m.call_id, { cancel: reason => finish('cancelled', reason === 'turn_interrupted' ? 'Turn stopped' : 'Cancelled') });
  });
}

const hostOf = origin => { try { return new URL(origin).host; } catch { return origin; } };

// The site a call acts on: the page for tab tools, the destination for open_url.
async function targetOrigin(m) {
  try {
    if (m.tool === 'open_url') return new URL(m.args.url).origin;
    const t = Number.isInteger(m.args.tab) ? await chrome.tabs.get(m.args.tab) : await tab();
    const o = new URL(t.url).origin;
    return /^https?:/.test(o) ? o : '';
  } catch { return ''; }
}

async function describeTarget(m) {
  if (m.tool === 'open_url') return m.args.new_tab === false ? 'in the current tab' : 'in a new tab';
  try {
    const t = Number.isInteger(m.args.tab) ? await chrome.tabs.get(m.args.tab) : await tab();
    return `on ${new URL(t.url).hostname} — ${t.title || ''}`;
  } catch { return ''; }
}

// Plain-language body for action cards: what each ref/selector points at.
async function cardText(m) {
  const a = m.args, tgt = x => ({ ref: x.ref, selector: x.selector });
  const quote = v => JSON.stringify(String(v).length > 200 ? String(v).slice(0, 200) + '…' : String(v));
  try {
    const t = await targetTab(a.tab);
    if (m.tool === 'click') return 'click → ' + (await agent(t.id, 'labels', [tgt(a)]))[0];
    if (m.tool === 'fill') return (await agent(t.id, 'labels', [tgt(a)]))[0] + '\n  ← ' + quote(a.text);
    if (m.tool === 'fill_form') {
      const all = a.fields.map(tgt).concat(a.submit ? [tgt(a.submit)] : []);
      const names = await agent(t.id, 'labels', all);
      const lines = a.fields.map((f, i) => names[i] + '\n  ← ' + quote(f.value));
      if (a.submit) lines.push('then click → ' + names[names.length - 1]);
      return lines.join('\n');
    }
  } catch {}
  return null;  // fall back to the raw arguments
}

// Tools whose arguments reach a site: putting a real value there discloses it, so a
// call that uses redacted values always asks (no reviewer approval, no grant).
const DISCLOSING_TOOLS = new Set(['fill', 'fill_form', 'open_url', 'fetch_as_user']);

async function handleCall(m) {
  if (m.tool === 'reveal') return revealCall(m);
  const handler = BROWSER_HANDLERS[m.tool];
  if (!handler) return { ok: false, error: `Unknown tool ${m.tool}` };
  // Placeholders in arguments get their real values here, in the browser. run_js is
  // left alone: arbitrary code with real values could send them anywhere.
  const shownArgs = m.args;
  let piiUsed = [];
  if (m.tool !== 'run_js') {
    const u = redactor.unredactDeep(m.args);
    m.args = u.value; piiUsed = u.used;
  }
  const disclosing = piiUsed.length > 0 && DISCLOSING_TOOLS.has(m.tool);
  let via = null;
  if (BROWSER_TOOL_POLICY[m.tool] !== 'auto' || disclosing) {
    const cls = TOOL_CLASS[m.tool], origin = await targetOrigin(m);
    const key = cls + '|' + origin;
    const flagged = m.review?.verdict === 'deny';  // always put to the user
    m.piiUsed = disclosing ? piiUsed : [];
    if (disclosing) {
      m.cardText = await cardText(m);
      const verdict = await confirmCard(m, await describeTarget(m), '');
      if (verdict !== 'allow') return { ok: false, error: verdict === 'deny' ? 'The user denied this action.' : 'Not approved in time.' };
      piiUsed.forEach(ph => redactor.shared.add(ph));
    } else if (!flagged && cls && origin && grants.has(key)) {
      via = ['granted', `You allowed ${CLASS_LABEL[cls]} on ${hostOf(origin)} for this conversation`];
    } else if (reviewerAuto && m.review?.verdict === 'approve' && REVIEWER_CLASSES.has(cls)) {
      via = ['reviewed', 'Approved by Hermes\'s reviewer: ' + (m.review.reason || '')];
    } else {
      m.cardText = await cardText(m);
      const verdict = await confirmCard(m, await describeTarget(m), origin);
      if (verdict === 'grant') grants.add(key);
      else if (verdict !== 'allow') return { ok: false, error: verdict === 'deny' ? 'The user denied this action.' : 'Not approved in time.' };
    }
  }
  const line = activityLine(m.tool, shownArgs);
  if (via) line.via(...via);
  // Results are redacted before they leave the browser (per the target site's setting).
  let url = '';
  try { url = m.tool === 'open_url' ? m.args.url : (await targetTab(m.args.tab)).url; } catch {}
  try {
    const raw = await handler(m.args, { signal: m.signal });
    // Binary payloads (screenshots) are not text: keep them out of the text redactor.
    const image = raw && typeof raw === 'object' ? raw.image : null;
    if (image) delete raw.image;
    const { value: content, found } = await redactor.redactDeep(raw, { url });
    if (image) content.image = image;
    if (found.length) line.via(`🛡 ${found.length}`, 'Hidden from Hermes:\n' + redactedNote(found));
    line.done(true);
    return { ok: true, content };
  } catch (e) {
    line.done(false, e.message);
    return { ok: false, error: (await redactor.redact(String(e.message), { url })).text };
  }
}

/* ---------- reveal: Hermes asks for real values behind placeholders ---------- */
function revealCard(m, known) {
  return new Promise(resolve => {
    const flagged = m.review?.verdict === 'deny';
    const card = document.createElement('div'); card.className = 'confirm reveal' + (flagged ? ' flagged' : '');
    const head = document.createElement('div'); head.className = 'confirm-head';
    head.textContent = `Hermes asks for ${known.length} redacted value${known.length === 1 ? '' : 's'}`;
    const why = document.createElement('div'); why.className = 'confirm-where';
    why.textContent = 'Purpose: ' + (String(m.args.purpose || '').slice(0, 300) || '(none given)');
    const parts = [head, why];
    if (m.review && m.review.reason) {
      const rv = document.createElement('div'); rv.className = 'confirm-review ' + m.review.verdict;
      rv.textContent = ({ approve: 'Reviewer: looks fine — ', escalate: 'Reviewer: check this — ',
                          deny: 'Reviewer flagged this — ' })[m.review.verdict] + m.review.reason;
      parts.push(rv);
    }
    const list = document.createElement('div'); list.className = 'reveal-list';
    const boxes = known.map(ph => {
      const row = document.createElement('label'); row.className = 'reveal-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.value = ph;
      const name = document.createElement('code'); name.textContent = ph;
      const val = document.createElement('span'); val.textContent = redactor.lookup(ph).value;
      row.append(cb, name, val); list.append(row);
      return cb;
    });
    const alwaysRow = document.createElement('label'); alwaysRow.className = 'reveal-always';
    const always = document.createElement('input'); always.type = 'checkbox';
    alwaysRow.append(always, document.createTextNode(" Don't ask again for these in this conversation"));
    const row = document.createElement('div'); row.className = 'confirm-row';
    const ok = document.createElement('button'); ok.className = 'btn-allow'; ok.textContent = 'Reveal selected';
    const deny = document.createElement('button'); deny.className = 'btn-deny'; deny.textContent = 'Deny';
    const note = document.createElement('span'); note.className = 'confirm-note';
    row.append(ok, deny, note);
    card.append(...parts, list, alwaysRow, row);
    callsContainer().appendChild(card); toBottom(true);
    boxes.forEach(cb => cb.onchange = () => { ok.disabled = !boxes.some(b => b.checked); });

    let settled = false;
    const finish = (result, text, cls) => {
      if (settled) return; settled = true;
      clearTimeout(timer); pendingCards.delete(m.call_id);
      [ok, deny, always, ...boxes].forEach(b => b.disabled = true);
      card.classList.add('done', cls); note.textContent = text;
      resolve(result);
    };
    ok.onclick = () => {
      const selected = boxes.filter(b => b.checked).map(b => b.value);
      finish({ selected, always: always.checked }, `Revealed ${selected.length}`, 'allow');
    };
    deny.onclick = () => finish(null, 'Denied', 'deny');
    const timer = setTimeout(() => finish(null, 'Timed out', 'cancelled'), Math.max(1000, m.deadline_ms - 1000));
    pendingCards.set(m.call_id, { cancel: () => finish(null, 'Cancelled', 'cancelled') });
  });
}

async function revealCall(m) {
  const asked = [...new Set((m.args.placeholders || []).map(String))];
  const known = asked.filter(ph => redactor.lookup(ph));
  const unknown = asked.filter(ph => !redactor.lookup(ph));
  if (!known.length) return { ok: true, content: { revealed: {}, withheld: asked, note: 'None of these placeholders exist in this conversation.' } };
  let chosen, via = null;
  if (m.review?.verdict !== 'deny' && known.every(ph => redactor.always.has(ph))) {
    chosen = known; via = ['allowed', 'You chose not to be asked again for these values'];
  } else {
    const r = await revealCard(m, known);
    if (!r) return { ok: false, error: 'The user did not reveal these values.' };
    chosen = r.selected;
    if (r.always) chosen.forEach(ph => redactor.always.add(ph));
  }
  const revealed = {};
  for (const ph of chosen) { revealed[ph] = redactor.lookup(ph).value; redactor.shared.add(ph); }
  const line = activityLine('reveal', {});
  line.via(`🛡 revealed ${chosen.length}`, chosen.join('\n'));
  if (via) line.via(...via);
  line.done(true);
  // Deliberately not redacted: this is the one path for real values to reach Hermes.
  return { ok: true, content: { revealed, withheld: [...known.filter(ph => !chosen.includes(ph)), ...unknown] } };
}

/* ---------- composer ---------- */
function autosize() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 180) + 'px'; updateSend(); }
const isBusy = () => !!controller || platformBusy;
function updateSend() { sendBtn.disabled = !isBusy() && !q.value.trim(); }
function stopTurn() { if (controller) controller.abort(); else if (platformBusy) outrigger.chatStop(chatId); }
q.addEventListener('input', () => { autosize(); updateMenu(); });
q.addEventListener('keydown', e => {
  if (menuKey(e)) return;
  // On the platform you may send while Hermes works (the gateway queues or steers it).
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); hideMenu(); if (!controller) send(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menuOpen() && isBusy()) stopTurn(); });
form.onsubmit = e => { e.preventDefault(); (isBusy() && !q.value.trim()) ? stopTurn() : send(); };
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { q.value = c.dataset.q; send(); });
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('clear').onclick = () => {
  if (controller) controller.abort();
  for (const c of pendingCards.values()) c.cancel('cancelled');
  sessionId = newSessionId(); if (!usingToken) outrigger.bind(sessionId); grants = new Set(); lastSentPage = null; redactor.reset();
  chatId = newChatId(); platformMsgs.clear(); platformFill = null; setPlatformBusy(false);
  log.querySelectorAll('.msg').forEach(m => m.remove()); empty.hidden = false; q.focus();
  transcript = []; forget();
};
autosize();

/* ---------- Chat / Note views ---------- */
function showView(v) {
  const note = v === 'note';
  $('noteView').hidden = !note;
  $('log').hidden = note; $('pageCard').hidden = note; form.hidden = note;
  $('noteToggle').classList.toggle('active', note);
  $('noteToggle').title = note ? 'Back to chat' : 'Notes on the Hermes host';
  try { chrome.storage.session.set({ view: v }); } catch {}
  if (note && !NB.active) NB.openPicker('');
}
$('noteToggle').onclick = () => showView($('noteView').hidden ? 'note' : 'chat');
NB.init();
chrome.storage.session.get('view').then(v => { if (v.view === 'note') showView('note'); }).catch(() => {});

function setBusy(on) {
  document.body.classList.toggle('busy', on);
  sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  if (on) setStatus('busy', 'Thinking…'); else checkKey();
  updateSend();
}

/* ---------- Outrigger platform chat ---------- */
/* ---------- finish notification (proposal 8) ---------- */
let turnStarted = 0, notifyDone = true;
chrome.storage.local.get('notifyDone').then(v => { notifyDone = v.notifyDone !== false; });
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.notifyDone) notifyDone = c.notifyDone.newValue !== false; });
function turnFinished(replyText) {
  const took = Date.now() - turnStarted; turnStarted = 0;
  if (!notifyDone || took < 20000 || (!document.hidden && document.hasFocus())) return;
  // Put real values back first: stripping Markdown would break ⟦TYPE_n⟧ placeholders.
  const text = redactor.unredact(String(replyText || 'Reply ready')).replace(/[#*`>]|\b_|_\b/g, '').replace(/\s+/g, ' ').trim();
  try {
    chrome.notifications.create('hermes-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon-128.png',
      title: 'Hermes replied', message: text.slice(0, 180) || 'Reply ready', priority: 0 });
  } catch {}
}
const lastReplyText = () => { const b = [...log.querySelectorAll('.msg.assistant .body')].pop(); return b ? b.textContent : ''; };

function setPlatformBusy(on) {
  clearTimeout(platformIdle);
  if (platformBusy === on) { if (on) armIdle(); return; }
  platformBusy = on;
  if (on) turnStarted = Date.now(); else if (turnStarted) turnFinished(lastReplyText());
  document.body.classList.toggle('busy', on || !!controller);
  sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  if (on) { setStatus('busy', 'Working…'); armIdle(); } else { checkKey(); platformFill = null; }
  updateSend();
}
// There is no explicit end-of-turn frame: Hermes sends typing while it works, so the
// turn counts as done after a quiet spell following a reply.
function armIdle() { clearTimeout(platformIdle); platformIdle = setTimeout(() => setPlatformBusy(false), 7000); }

function sendViaPlatform(content, pageSent) {
  const mid = 'm-' + crypto.randomUUID();
  if (pageSent) pendingPage.set(mid, pageSent);
  platformFill = addAssistant();
  currentOut = platformFill;  // tool cards for this turn land here
  setPlatformBusy(true);
  outrigger.chatSend(chatId, content, mid);
  q.focus();
}

/* ---------- Hermes's interactive prompts (Outrigger platform; prompts.js) ---------- */
// Where a prompt card goes: the reply bubble waiting for this turn, else a new one.
function promptHost() {
  let el = platformFill && platformFill.isConnected && !platformFill.dataset.filled ? platformFill : addAssistant();
  el.dataset.filled = '1';
  el.querySelector('.body').textContent = '';
  if (el !== platformFill) platformFill = null;
  return el.querySelector('.calls');
}
const prompts = createPrompts({
  host: promptHost,
  send: (chat, kind, id, value) => outrigger.chatAction(chat, kind, id, value),
  defaultChat: () => chatId,
  afterAnswer: chat => { if (!platformBusy && chat === chatId) setPlatformBusy(true); },
  focusComposer: () => $('q').focus(),
  onRendered: () => { toBottom(true); if (platformBusy) armIdle(); },
});
const PROMPT_RENDERERS = prompts.renderers;
const renderPrompt = (m, el) => prompts.render(m, el);
const promptResult = m => prompts.result(m);

/* ---------- / autocomplete (Hermes commands, Outrigger platform) ---------- */
let hermesCommands = [];  // from the plugin's build-time catalog (chat.commands)
let menuItems = [], menuSel = 0;
const cmdMenu = (() => {
  const m = document.createElement('div'); m.id = 'cmdMenu'; m.className = 'cmd-menu'; m.hidden = true;
  m.setAttribute('role', 'listbox'); form.prepend(m); return m;
})();
const menuOpen = () => !cmdMenu.hidden;
function hideMenu() { cmdMenu.hidden = true; menuItems = []; }
function updateMenu() {
  const v = q.value;
  if (!usePlatform() || !hermesCommands.length || !v.startsWith('/') || /\s/.test(v)) return hideMenu();
  const f = v.slice(1).toLowerCase();
  const starts = c => c.name.startsWith(f) || (c.aliases || []).some(a => a.startsWith(f));
  const has = c => c.name.includes(f) || (c.description || '').toLowerCase().includes(f);
  menuItems = [...hermesCommands.filter(starts), ...(f ? hermesCommands.filter(c => !starts(c) && has(c)) : [])].slice(0, 8);
  if (!menuItems.length) return hideMenu();
  menuSel = 0; renderMenu(); cmdMenu.hidden = false;
}
function renderMenu() {
  cmdMenu.innerHTML = '';
  menuItems.forEach((c, i) => {
    const row = document.createElement('div'); row.className = 'cmd-item' + (i === menuSel ? ' sel' : '');
    row.setAttribute('role', 'option');
    const name = document.createElement('span'); name.className = 'cmd-name'; name.textContent = '/' + c.name;
    const hint = document.createElement('span'); hint.className = 'cmd-hint'; hint.textContent = c.args_hint || '';
    const desc = document.createElement('div'); desc.className = 'cmd-desc'; desc.textContent = c.description || '';
    row.append(name, hint, desc);
    row.onmousedown = ev => { ev.preventDefault(); menuSel = i; chooseMenu(); };
    cmdMenu.append(row);
  });
}
function chooseMenu() {
  const c = menuItems[menuSel]; if (!c) return;
  q.value = '/' + c.name + (c.args_hint ? ' ' : '');
  hideMenu(); autosize(); q.focus();
}
// Returns true when the key was handled by the menu.
function menuKey(e) {
  if (!menuOpen()) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); menuSel = (menuSel + (e.key === 'ArrowDown' ? 1 : -1) + menuItems.length) % menuItems.length; renderMenu(); return true;
  }
  if (e.key === 'Tab') { e.preventDefault(); chooseMenu(); return true; }
  if (e.key === 'Enter' && !e.shiftKey) {
    // A command typed in full is sent; otherwise Enter completes the selection.
    if (menuItems[menuSel] && q.value.slice(1).toLowerCase() === menuItems[menuSel].name) { hideMenu(); return false; }
    e.preventDefault(); chooseMenu(); return true;
  }
  if (e.key === 'Escape') { e.preventDefault(); hideMenu(); return true; }
  return false;
}

/* ---------- media from Hermes (images, files) ---------- */
function renderMedia(m, restoring = false) {
  const el = !restoring && platformFill && platformFill.isConnected && !platformFill.dataset.filled ? platformFill : addAssistant();
  el.dataset.filled = '1';
  if (el !== platformFill) platformFill = null;
  const body = el.querySelector('.body'); body.textContent = '';
  if (m.caption) { const c = document.createElement('p'); c.textContent = m.caption; body.append(c); }
  let href = '';
  if (m.data) {
    try {
      const bytes = Uint8Array.from(atob(m.data), ch => ch.charCodeAt(0));
      href = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'application/octet-stream' }));
    } catch { href = ''; }
  } else if (/^https?:\/\//.test(m.url || '')) href = m.url;
  if (m.kind === 'image' && href) {
    const img = document.createElement('img'); img.src = href; img.alt = m.name || 'image'; img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer'; body.append(img);
  } else {
    const a = document.createElement('a'); a.className = 'media-file';
    a.textContent = '📎 ' + (m.name || 'file') + (href ? '' : ' (not kept after closing the panel)');
    if (href) { a.href = href; if (m.data) a.download = m.name || 'file'; else { a.target = '_blank'; a.rel = 'noopener noreferrer'; } }
    body.append(a);
  }
  toBottom();
}

/* ---------- conversation memory (chrome.storage.session: memory only) ---------- */
let transcript = [];   // [{ role: 'user'|'assistant'|'media', text?, tag?, mid?, … }]
let storeKey = null, saveTimer = 0;
function remember(entry) {
  if (entry.mid) {
    const i = transcript.findIndex(t => t.mid === entry.mid);
    if (i >= 0) { transcript[i] = entry; persist(); return; }
  }
  transcript.push(entry); persist();
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 300); }
async function save() {
  if (!storeKey) return;
  try {
    await chrome.storage.session.set({ [storeKey]: { v: 1, chatId, sessionId, transcript: transcript.slice(-200),
      redactor: redactor.exportState(), grants: [...grants], lastSentPage } });
  } catch (e) { console.warn('could not keep the conversation', e); }
}
function forget() { if (storeKey) chrome.storage.session.remove(storeKey).catch(() => {}); }
async function restore() {
  let s = null;
  try { s = (await chrome.storage.session.get(storeKey))[storeKey]; } catch {}
  if (!s || s.v !== 1 || !Array.isArray(s.transcript) || !s.transcript.length) return;
  chatId = s.chatId || chatId; sessionId = s.sessionId || sessionId;
  redactor.importState(s.redactor); grants = new Set(s.grants || []); lastSentPage = s.lastSentPage || null;
  transcript = s.transcript;
  for (const t of transcript) {
    if (t.role === 'user') addUser(t.text, t.tag);
    else if (t.role === 'assistant') { const el = addAssistant(); el.dataset.filled = '1'; renderInto(el, t.text, false); addTools(el, t.text, false); }
    else if (t.role === 'media') renderMedia(t, true);
  }
  // Point the connection at the restored conversation; replies that came while the
  // panel was closed are delivered from the plugin's outbox on attach.
  if (!usingToken) outrigger.bind(sessionId);
  if (outrigger.attached && outrigger.platformAvailable) outrigger.chatAttach(chatId);
}
chrome.windows.getCurrent().then(w => { storeKey = 'conv-' + w.id; restore().then(takePendingAsk); }).catch(() => {});

/* ---------- right-click "Ask Hermes" (proposal 4; background.js stores the item) ---------- */
async function takePendingAsk() {
  let a = null;
  try { a = (await chrome.storage.session.get('pendingAsk')).pendingAsk; } catch {}
  if (!a || Date.now() - a.ts > 60000) return;
  const w = await chrome.windows.getCurrent().catch(() => null);
  if (w && a.windowId !== w.id) return;
  await chrome.storage.session.remove('pendingAsk').catch(() => {});
  const quote = s => String(s).trim().split('\n').map(l => '> ' + l).join('\n');
  q.value = a.kind === 'selection' ? `About this selection:\n${quote(a.text).slice(0, 4000)}\n\n`
    : a.kind === 'link' ? `About this link: ${a.url}\n`
    : a.kind === 'image' ? `About this image: ${a.url}\n`
    : 'About this page: ';
  if (a.kind === 'page' && !inc.checked) { inc.checked = true; syncInc(); }
  autosize(); q.focus(); q.setSelectionRange(q.value.length, q.value.length);
}
chrome.storage.onChanged.addListener((c, area) => { if (area === 'session' && c.pendingAsk?.newValue) takePendingAsk(); });

const isStatusText = t => typeof t === 'string' && t.length <= 120 && !t.includes('\n') &&
  /^\p{Extended_Pictographic}/u.test(t.trim());

function onChatFrame(m) {
  // The open note's own chat (a // command's turn): prompts go to the Note view, the
  // summary to its result bar.
  if (m.chat_id && NB.isNoteChat(m.chat_id)) {
    if (PROMPT_RENDERERS[m.type]) { renderPrompt(m, $('notePrompts')); return; }
    if (m.type === 'chat.action_result') { promptResult(m); return; }
    NB.onChat(m); return;
  }
  if (m.type === 'error') {
    if (!platformBusy) return;
    const el = platformFill || addAssistant();
    el.classList.add('err'); el.querySelector('.body').textContent = m.message || m.code;
    platformFill = null; setPlatformBusy(false);
    return;
  }
  if (m.type === 'chat.commands') { hermesCommands = Array.isArray(m.commands) ? m.commands : []; return; }
  if (m.chat_id !== chatId) return;  // other chats (e.g. home) are not shown yet
  if (m.type === 'chat.media') { renderMedia(m); remember({ role: 'media', mid: m.message_id, kind: m.kind, name: m.name, url: m.url, caption: m.caption }); if (platformBusy) armIdle(); return; }
  if (m.type === 'chat.accepted') {
    const p = pendingPage.get(m.client_msg_id);
    if (p) { lastSentPage = p; pendingPage.delete(m.client_msg_id); }
    return;
  }
  if (PROMPT_RENDERERS[m.type]) { renderPrompt(m); return; }
  if (m.type === 'chat.action_result') { promptResult(m); return; }
  if (m.type === 'chat.typing') { if (platformBusy) armIdle(); else setPlatformBusy(true); return; }
  if (m.type === 'chat.message' || m.type === 'chat.edit') {
    let entry = platformMsgs.get(m.message_id);
    // Hermes's mid-turn status sends ("🛶 outrigger_call...", "🧠 … recalled 1 memory") carry no
    // public marker on plugin platforms, so a short one-line emoji-led message during a turn
    // is shown as a muted status line in the turn's latest bubble instead of a bubble of its own.
    const statusHost = platformFill?.isConnected ? platformFill : [...log.querySelectorAll('.msg.assistant')].pop();
    if ((!entry && isStatusText(m.text) && platformBusy && statusHost) || entry?.status) {
      if (!entry) {
        const line = document.createElement('div'); line.className = 'status-line';
        statusHost.querySelector('.calls').appendChild(line);
        entry = { el: line, status: true, text: '' };
        platformMsgs.set(m.message_id, entry);
      }
      entry.text = m.text || ''; entry.el.textContent = entry.text;
      if (platformBusy) armIdle();
      toBottom();
      return;
    }
    if (!entry) {
      // The first reply of a turn fills the waiting bubble; later ones get their own.
      const el = platformFill && platformFill.isConnected && !platformFill.dataset.filled ? platformFill : addAssistant();
      el.dataset.filled = '1';
      entry = { el, text: '' };
      platformMsgs.set(m.message_id, entry);
      if (el !== platformFill) platformFill = null;
    }
    entry.text = m.text || '';
    const streaming = m.type === 'chat.edit' && !m.final;
    renderInto(entry.el, entry.text || '…', streaming);
    if (!streaming) { addTools(entry.el, entry.text, false); remember({ role: 'assistant', text: entry.text, mid: m.message_id }); }
    if (platformBusy) armIdle();
  }
}

/* ---------- send ---------- */
async function send() {
  const text = q.value.trim(); if (!text || controller) return;
  q.value = ''; autosize(); lastQuestion = text;
  const { endpoint = DEFAULT_ENDPOINT, key = '' } = await chrome.storage.local.get(['endpoint', 'key']);
  if (!key) {
    const m = addAssistant(); m.classList.add('err');
    m.querySelector('.body').innerHTML = 'No API key set. <a href="#" id="openOpts">Open settings</a> and paste your <code>API_SERVER_KEY</code>.';
    m.querySelector('#openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    q.value = text; autosize(); return;
  }

  // /note [query]: open a note from the Hermes host (handled here, not by Hermes).
  const noteCmd = text.match(/^\/note(?:\s+(.*))?$/);
  if (noteCmd) { showView('note'); NB.openPicker(noteCmd[1] || ''); return; }
  // Decide platform vs Chat Completions only once the connection has had a moment.
  if (platformPref && outrigger.state === 'connecting') await outrigger.ready(2000);
  let content = text, tag = '', pageSent = null;
  // Slash commands go to Hermes as typed (no page attached), through the platform.
  const isCommand = text.startsWith('/') && usePlatform();
  if (inc.checked && !isCommand) {
    const p = await grab();
    const pageText = (p.text || '').slice(0, MAX);
    const textHash = await sha256(pageText);
    const samePage = lastSentPage && lastSentPage.url === p.url && lastSentPage.textHash === textHash;
    const newSel = p.sel && !(lastSentPage && lastSentPage.url === p.url && lastSentPage.sel === p.sel);
    let ctx = `[Page: ${p.title}]\n[URL: ${p.url}]\n`;
    if (newSel) ctx += `[Selected text]\n${p.sel}\n`;
    if (samePage) {
      ctx += '[Page text unchanged; it was attached earlier in this conversation]\n';
    } else {
      if (pageText) ctx += `[Page text${p.text.length > MAX ? ' (truncated)' : ''}]\n${pageText}\n`;
      if (p.err) ctx += `[Could not read page text: ${p.err}]\n`;
    }
    content = ctx + '\n[Question]\n' + text;
    tag = samePage ? (newSel ? '＋ selection · page already sent' : '· page already sent')
        : p.sel ? '＋ page & selection' : pageText ? '＋ page' : '⚠ page unreadable';
    pageSent = { url: p.url, textHash, sel: p.sel || (samePage ? lastSentPage.sel : '') };
  }
  // Redact personal data (per the tab's site setting) before it leaves the browser.
  const pageUrl = (await tab())?.url || '';
  const red = await redactor.redact(content, { url: pageUrl });
  content = red.text;
  addUser(text, tag, red.found);
  remember({ role: 'user', text, tag: tag + (red.found.length ? (tag ? ' · ' : '') + `🛡 ${red.found.length} redacted` : '') });
  if (usePlatform()) return sendViaPlatform(content, pageSent);
  if (/^otr_/.test(key)) {  // client tokens can only chat through the Outrigger platform
    const m = addAssistant(); m.classList.add('err');
    m.querySelector('.body').textContent = 'Chatting with an Outrigger token needs the Outrigger platform, which is not available right now (gateway offline, plugin platform off, or "Chat through the Outrigger platform" unchecked in settings).';
    return;
  }

  const out = addAssistant(); let acc = '', raf = 0;
  currentOut = out;
  controller = new AbortController(); setBusy(true); turnStarted = Date.now();
  // Hermes fixes a session's tools when it starts: attach before the first message.
  if (outrigger.state === 'connecting') await outrigger.ready(2000);
  const paint = () => { raf = 0; renderInto(out, acc, true); };
  try {
    const r = await fetch(endpoint.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Hermes-Session-Id': sessionId },
      // History lives in the Hermes session; send only this turn.
      body: JSON.stringify({ model: 'hermes-agent', stream: true, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }] })
    });
    if (!r.ok) throw new Error(r.status === 401 ? '401 Unauthorized — check the API key in settings.' : r.status + ' ' + (await r.text()).slice(0, 300));
    // Hermes accepted the turn, so the page is now in its history.
    if (pageSent) lastSentPage = pageSent;
    setStatus('busy', 'Responding…');
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) { acc += d; if (!raf) raf = requestAnimationFrame(paint); } } catch {}
      }
    }
    cancelAnimationFrame(raf); renderInto(out, acc || '_(empty response)_', false);
    if (acc) remember({ role: 'assistant', text: acc });
    turnFinished(acc);
    addTools(out, acc, false);
  } catch (e) {
    cancelAnimationFrame(raf);
    if (e.name === 'AbortError') {
      renderInto(out, acc, false);
      out.querySelector('.body').insertAdjacentHTML('beforeend', '<div class="stopped">Stopped</div>');
      addTools(out, acc, !acc);
    } else {
      out.classList.add('err');
      const msg = /Failed to fetch|NetworkError/.test(e.message) ? `Can't reach Hermes at ${endpoint}. Is the gateway running?` : e.message;
      out.querySelector('.body').textContent = msg;
      addTools(out, '', true);
    }
  } finally {
    controller = null; currentOut = null; setBusy(false); q.focus();
  }
}
