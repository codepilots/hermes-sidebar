const $ = id => document.getElementById(id);
const e = $('endpoint'), k = $('key'), st = $('st'), bt = $('browserTools'), ra = $('reviewerAuto'), pc = $('platformChat'),
  nd = $('notifyDone'), pt = $('personalTools'), rd = $('redact'), cats = $('redactCats'), skip = $('redactSkip');
const say = (t, cls = '') => { st.textContent = t; st.className = cls; };

/* ---------- sections ---------- */
const SECTIONS = [...document.querySelectorAll('#nav a')].map(a => a.dataset.sec);
function show(sec) {
  if (!SECTIONS.includes(sec)) sec = SECTIONS[0];
  document.querySelectorAll('.sec').forEach(s => s.classList.toggle('active', s.id === sec));
  document.querySelectorAll('#nav a').forEach(a => {
    const on = a.dataset.sec === sec;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
addEventListener('hashchange', () => show(location.hash.slice(1)));
show(location.hash.slice(1));

/* ---------- load ---------- */
// Category list and defaults come from redactor.js (PII_CATEGORIES).
for (const [id, c] of Object.entries(PII_CATEGORIES)) {
  const l = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.cat = id; cb.checked = c.default;
  l.append(cb, document.createTextNode(c.label)); cats.append(l);
}
const syncCats = () => $('redactSub').classList.toggle('off', !rd.checked);

chrome.storage.local.get(['endpoint', 'key', 'browserTools', 'reviewerAuto', 'redact', 'redactCats', 'redactSkip', 'platformChat', 'notifyDone']).then(v => {
  e.value = v.endpoint || 'http://127.0.0.1:8642'; k.value = v.key || '';
  pc.checked = v.platformChat !== false; nd.checked = v.notifyDone !== false;
  bt.checked = v.browserTools !== false; ra.checked = v.reviewerAuto !== false;
  rd.checked = v.redact !== false;
  cats.querySelectorAll('input').forEach(cb => { if (v.redactCats && cb.dataset.cat in v.redactCats) cb.checked = !!v.redactCats[cb.dataset.cat]; });
  skip.value = (v.redactSkip || []).join('\n');
  syncCats();
});

/* ---------- save on change ---------- */
let savedTimer;
function flash() {
  const el = $('saved'); el.textContent = 'Saved ✓'; el.classList.add('show');
  clearTimeout(savedTimer); savedTimer = setTimeout(() => el.classList.remove('show'), 1500);
}
async function save() {
  await chrome.storage.local.set({
    endpoint: e.value.trim().replace(/\/$/, '') || 'http://127.0.0.1:8642', key: k.value.trim(),
    browserTools: bt.checked, reviewerAuto: ra.checked, platformChat: pc.checked, notifyDone: nd.checked,
    redact: rd.checked,
    redactCats: Object.fromEntries([...cats.querySelectorAll('input')].map(cb => [cb.dataset.cat, cb.checked])),
    redactSkip: skip.value.split(/\s+/).map(h => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean),
  });
  flash();
}
// Checkboxes save at once; text fields when you leave them (or press Enter in a one-line field).
[bt, ra, pc, nd, rd].forEach(i => i.addEventListener('change', save));
cats.addEventListener('change', save);
rd.addEventListener('change', syncCats);
[e, k, skip].forEach(i => i.addEventListener('change', save));
[e, k].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') i.blur(); }));

// History and bookmarks are optional permissions: requested (or removed) right here, on the
// user's click; the panel offers the tools only while they are granted.
const PERSONAL = { permissions: ['history', 'bookmarks'] };
chrome.permissions.contains(PERSONAL).then(has => { pt.checked = has; });
pt.onchange = async () => {
  const ok = pt.checked ? await chrome.permissions.request(PERSONAL) : await chrome.permissions.remove(PERSONAL);
  if (!ok) pt.checked = !pt.checked;
  await chrome.storage.local.set({ personalToolsChanged: Date.now() });  // the panel re-offers its tools
  if (ok) flash();
};

$('reveal').onclick = () => { k.type = k.type === 'password' ? 'text' : 'password'; };

/* ---------- test connection ---------- */
// Everything the sidebar needs goes over the outrigger WebSocket, so test that: it works
// for the API key and paired tokens alike, and through a tunnel that exposes only
// /v1/outrigger/ws (docs/remote-access.md in hermes-outrigger).
function testWS(base, key) {
  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/outrigger/ws', ['hermes-outrigger.v1', 'bearer.' + key]); }
    catch { return resolve({ ok: false, msg: "That address doesn't look right" }); }
    const t = setTimeout(() => { ws.close(); resolve({ ok: false, msg: 'No answer from the gateway' }); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 2, client: { name: 'hermes-sidebar-test' }, tools: [], capabilities: ['chat'] }));
    ws.onmessage = ev => {
      clearTimeout(t); ws.close();
      try { const m = JSON.parse(ev.data);
        if (m.type !== 'welcome') return resolve({ ok: false, msg: m.message || 'Refused' });
        resolve({ ok: true, platform: !!m.platform?.available });
      } catch { resolve({ ok: false, msg: 'Unexpected reply' }); }
    };
    ws.onclose = ev => {
      clearTimeout(t);
      if (ev.code !== 1006) return resolve({ ok: false, msg: 'Closed by the gateway' });
      // The browser hides the HTTP status of a refused WebSocket: say what it can be.
      const remote = !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(base);
      resolve({ ok: false, msg: remote && !/^otr_/.test(key)
        ? 'Refused or unreachable. Remotely, use a paired token (the API key only works on the Hermes machine).'
        : 'Refused or unreachable: check the address, the key or token, and that the outrigger plugin is enabled.' });
    };
  });
}

$('test').onclick = async () => {
  await save();
  const base = e.value.trim().replace(/\/$/, ''), key = k.value.trim();
  if (!key) return say('Add an API key or token first', 'bad');
  say('Testing…');
  const r = await testWS(base, key);
  if (!r.ok) return say(r.msg, 'bad');
  say((/^otr_/.test(key) ? 'Connected with token ✓' : 'Connected ✓') + (r.platform ? '' : ' (Outrigger platform off: chat uses Chat Completions)'), 'ok');
};

/* ---------- about ---------- */
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const link = (url, text) => { const a = el('a', '', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };

const version = chrome.runtime.getManifest().version;
$('version').textContent = 'Version ' + version;
$('aboutVersion').textContent = 'v' + version;
$('hermesLink').textContent = PROJECT.hermes.label; $('hermesLink').href = PROJECT.hermes.url;
$('projLicense').textContent = PROJECT.license + ' licence';
$('projCopyright').textContent = PROJECT.copyright;
$('projLicenceBtn').onclick = () => openLicence(PROJECT.name, 'LICENSE');
for (const r of PROJECT.repos) {
  const row = el('span', 'repo'); row.append(link(r.url, r.url.replace(/^https:\/\//, '')), el('small', '', ' — ' + r.what));
  $('repos').append(row);
}

for (const c of CREDITS) {
  const card = el('div', 'credit');
  const name = el('div', 'c-name'); name.append(link(c.url, c.name), el('span', 'c-ver', c.version));
  const lic = el('div', 'c-lic');
  lic.append(el('span', 'badge', c.license.split(' ')[0]));
  const btn = el('button', 'link', 'Licence'); btn.onclick = () => openLicence(c.name, c.file);
  lic.append(btn);
  card.append(name, lic, el('div', 'c-use', c.use), el('div', 'c-legal', c.copyright + ' · ' + c.license));
  $('credits').append(card);
}

async function openLicence(title, file) {
  $('licenceTitle').textContent = title + ' — licence';
  $('licenceText').textContent = 'Loading…';
  $('licence').showModal();
  try { $('licenceText').textContent = await (await fetch(chrome.runtime.getURL(file))).text(); }
  catch { $('licenceText').textContent = `Could not load ${file}.`; }
}
$('licenceClose').onclick = () => $('licence').close();
$('licence').addEventListener('click', ev => { if (ev.target === $('licence')) $('licence').close(); });
