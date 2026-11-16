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
  outrigger.tools = BROWSER_TOOLS.filter(t => t.name !== 'reveal' || redact);
  outrigger.redaction = { enabled: redact, categories: redact ? redactor.categories() : [] };
}

async function syncOutrigger() {
  await loadRedaction();
  const { endpoint = DEFAULT_ENDPOINT, key = '', browserTools = true } =
    await chrome.storage.local.get(['endpoint', 'key', 'browserTools']);
  if (!key || !browserTools) return outrigger.stop();
  outrigger.start({ endpoint, key, sessionId });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  checkKey();
  if (changes.reviewerAuto) reviewerAuto = changes.reviewerAuto.newValue !== false;
  if (changes.endpoint || changes.key || changes.browserTools || changes.redact || changes.redactCats || changes.redactSkip) syncOutrigger();
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
    // No site-wide grant from a flagged card: it covers this one call only.
    if (cls && origin && !flagged) {
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
    const { value: content, found } = await redactor.redactDeep(raw, { url });
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
function updateSend() { sendBtn.disabled = !controller && !q.value.trim(); }
q.addEventListener('input', autosize);
q.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!controller) send(); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && controller) controller.abort(); });
form.onsubmit = e => { e.preventDefault(); controller ? controller.abort() : send(); };
document.querySelectorAll('.chip').forEach(c => c.onclick = () => { q.value = c.dataset.q; send(); });
$('settings').onclick = () => chrome.runtime.openOptionsPage();
$('clear').onclick = () => {
  if (controller) controller.abort();
  for (const c of pendingCards.values()) c.cancel('cancelled');
  sessionId = newSessionId(); outrigger.bind(sessionId); grants = new Set(); lastSentPage = null; redactor.reset();
  log.querySelectorAll('.msg').forEach(m => m.remove()); empty.hidden = false; q.focus();
};
autosize();

function setBusy(on) {
  document.body.classList.toggle('busy', on);
  sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
  if (on) setStatus('busy', 'Thinking…'); else checkKey();
  updateSend();
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

  let content = text, tag = '', pageSent = null;
  if (inc.checked) {
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

  const out = addAssistant(); let acc = '', raf = 0;
  currentOut = out;
  controller = new AbortController(); setBusy(true);
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
