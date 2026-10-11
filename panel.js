const $ = id => document.getElementById(id);
const log = $('log'), q = $('q'), inc = $('inc'), form = $('f'), sendBtn = $('send'), empty = $('empty');
const MAX = 60000;
const SYSTEM = 'The user is asking from a Chromium sidebar about the web page they are reading. Page context is attached to their messages. Be concise.';
const ICON_COPY = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_OK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_RETRY = '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';

let history = [], controller = null, lastQuestion = '';

/* ---------- status ---------- */
function setStatus(kind, text) {
  const s = $('status'); s.className = 'status' + (kind ? ' ' + kind : ''); $('statusText').textContent = text;
}
async function checkKey() {
  const { key = '' } = await chrome.storage.local.get('key');
  if (!key) setStatus('warn', 'No API key — open settings'); else if (!controller) setStatus('', 'Ready');
}
chrome.storage.onChanged.addListener(checkKey);
checkKey();

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
}
chrome.tabs.onActivated.addListener(showTab);
chrome.tabs.onUpdated.addListener((i, c) => (c.title || c.favIconUrl || c.url) && showTab());
showTab();

const syncInc = () => $('pageCard').classList.toggle('off', !inc.checked);
inc.addEventListener('change', () => { syncInc(); chrome.storage.local.set({ includePage: inc.checked }); });
chrome.storage.local.get('includePage').then(v => { if (v.includePage === false) inc.checked = false; syncInc(); });

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

function addUser(text, tag) {
  empty.hidden = true;
  const d = document.createElement('div'); d.className = 'msg user';
  const b = document.createElement('div'); b.className = 'bubble'; b.textContent = text;
  if (tag) { const t = document.createElement('span'); t.className = 'ctx-tag'; t.textContent = tag; b.appendChild(t); }
  d.appendChild(b); log.appendChild(d); toBottom(true);
}

function addAssistant() {
  empty.hidden = true;
  const d = document.createElement('div'); d.className = 'msg assistant';
  d.innerHTML = '<div class="who"><img src="icons/icon-16.png" alt="">Hermes</div><div class="body"><span class="typing"><i></i><i></i><i></i></span></div><div class="tools"></div>';
  log.appendChild(d); toBottom(true);
  return d;
}

function renderInto(msgEl, text, streaming) {
  const body = msgEl.querySelector('.body');
  const stick = nearBottom();
  body.innerHTML = renderMarkdown(text);
  if (streaming) { const last = body.lastElementChild; (last && !last.classList.contains('code') ? last : body).classList.add('caret'); }
  if (stick) log.scrollTop = log.scrollHeight;
}

function addTools(msgEl, text, retry) {
  const tools = msgEl.querySelector('.tools'); tools.innerHTML = '';
  if (text) {
    const c = document.createElement('button'); c.className = 'icon-btn'; c.title = 'Copy response'; c.innerHTML = ICON_COPY;
    c.onclick = async () => { await navigator.clipboard.writeText(text); c.innerHTML = ICON_OK; setTimeout(() => c.innerHTML = ICON_COPY, 1200); };
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
  history = []; log.querySelectorAll('.msg').forEach(m => m.remove()); empty.hidden = false; q.focus();
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
  const { endpoint = 'http://127.0.0.1:8642', key = '' } = await chrome.storage.local.get(['endpoint', 'key']);
  if (!key) {
    const m = addAssistant(); m.classList.add('err');
    m.querySelector('.body').innerHTML = 'No API key set. <a href="#" id="openOpts">Open settings</a> and paste your <code>API_SERVER_KEY</code>.';
    m.querySelector('#openOpts').onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
    q.value = text; autosize(); return;
  }

  let content = text, tag = '';
  if (inc.checked) {
    const p = await grab();
    let ctx = `[Page: ${p.title}]\n[URL: ${p.url}]\n`;
    if (p.sel) ctx += `[Selected text]\n${p.sel}\n`;
    if (p.text) ctx += `[Page text${p.text.length > MAX ? ' (truncated)' : ''}]\n${p.text.slice(0, MAX)}\n`;
    if (p.err) ctx += `[Could not read page text: ${p.err}]\n`;
    content = ctx + '\n[Question]\n' + text;
    tag = p.sel ? '＋ page & selection' : p.text ? '＋ page' : '⚠ page unreadable';
  }
  addUser(text, tag); history.push({ role: 'user', content });

  const out = addAssistant(); let acc = '', raf = 0;
  controller = new AbortController(); setBusy(true);
  const paint = () => { raf = 0; renderInto(out, acc, true); };
  try {
    const r = await fetch(endpoint.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: 'hermes-agent', stream: true, messages: [{ role: 'system', content: SYSTEM }, ...history] })
    });
    if (!r.ok) throw new Error(r.status === 401 ? '401 Unauthorized — check the API key in settings.' : r.status + ' ' + (await r.text()).slice(0, 300));
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
    history.push({ role: 'assistant', content: acc }); addTools(out, acc, false);
  } catch (e) {
    cancelAnimationFrame(raf);
    if (e.name === 'AbortError') {
      renderInto(out, acc, false);
      out.querySelector('.body').insertAdjacentHTML('beforeend', '<div class="stopped">Stopped</div>');
      if (acc) history.push({ role: 'assistant', content: acc }); else history.pop();
      addTools(out, acc, !acc);
    } else {
      out.classList.add('err');
      const msg = /Failed to fetch|NetworkError/.test(e.message) ? `Can't reach Hermes at ${endpoint}. Is the gateway running?` : e.message;
      out.querySelector('.body').textContent = msg;
      history.pop(); addTools(out, '', true);
    }
  } finally {
    controller = null; setBusy(false); q.focus();
  }
}
