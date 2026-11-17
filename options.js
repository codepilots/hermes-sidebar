const e = document.getElementById('endpoint'), k = document.getElementById('key'), st = document.getElementById('st'), bt = document.getElementById('browserTools'), ra = document.getElementById('reviewerAuto'), pc = document.getElementById('platformChat'), nd = document.getElementById('notifyDone'), pt = document.getElementById('personalTools');
const say = (t, cls = '') => { st.textContent = t; st.className = cls; };
const rd = document.getElementById('redact'), cats = document.getElementById('redactCats'), skip = document.getElementById('redactSkip');
// Category list and defaults come from redactor.js (PII_CATEGORIES).
for (const [id, c] of Object.entries(PII_CATEGORIES)) {
  const l = document.createElement('label');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.cat = id; cb.checked = c.default;
  l.append(cb, document.createTextNode(c.label)); cats.append(l);
}
const syncCats = () => cats.classList.toggle('off', !rd.checked);
rd.onchange = syncCats;
chrome.storage.local.get(['endpoint', 'key', 'browserTools', 'reviewerAuto', 'redact', 'redactCats', 'redactSkip', 'platformChat']).then(v => {
  pc.checked = v.platformChat !== false;
  nd.checked = v.notifyDone !== false;
  e.value = v.endpoint || 'http://127.0.0.1:8642'; k.value = v.key || ''; bt.checked = v.browserTools !== false; ra.checked = v.reviewerAuto !== false;
  rd.checked = v.redact !== false;
  cats.querySelectorAll('input').forEach(cb => { if (v.redactCats && cb.dataset.cat in v.redactCats) cb.checked = !!v.redactCats[cb.dataset.cat]; });
  skip.value = (v.redactSkip || []).join('\n');
  syncCats();
});

// History and bookmarks are optional permissions: requested (or removed) right here, on the
// user's click; the panel offers the tools only while they are granted.
const PERSONAL = { permissions: ['history', 'bookmarks'] };
chrome.permissions.contains(PERSONAL).then(has => { pt.checked = has; });
pt.onchange = async () => {
  const ok = pt.checked ? await chrome.permissions.request(PERSONAL) : await chrome.permissions.remove(PERSONAL);
  if (!ok) pt.checked = !pt.checked;
  // Tell the panel to re-offer its tool list.
  await chrome.storage.local.set({ personalToolsChanged: Date.now() });
};

document.getElementById('reveal').onclick = () => { k.type = k.type === 'password' ? 'text' : 'password'; };

async function save() {
  await chrome.storage.local.set({ endpoint: e.value.trim().replace(/\/$/, ''), key: k.value.trim(), browserTools: bt.checked, reviewerAuto: ra.checked, platformChat: pc.checked, notifyDone: nd.checked,
    redact: rd.checked,
    redactCats: Object.fromEntries([...cats.querySelectorAll('input')].map(cb => [cb.dataset.cat, cb.checked])),
    redactSkip: skip.value.split(/\s+/).map(h => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean) });
  say('Saved ✓', 'ok');
}
document.getElementById('save').onclick = save;
[e, k].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); }));

// A client token (otr_…) only opens the outrigger WebSocket: test that instead of /v1/models.
function testToken(base, token) {
  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(base.replace(/^http/, 'ws') + '/v1/outrigger/ws', ['hermes-outrigger.v1', 'bearer.' + token]); }
    catch { return resolve("Can't reach gateway"); }
    const t = setTimeout(() => { ws.close(); resolve('No answer from the gateway'); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 2, client: { name: 'hermes-sidebar-test' }, tools: [], capabilities: ['chat'] }));
    ws.onmessage = ev => {
      clearTimeout(t); ws.close();
      try { const m = JSON.parse(ev.data);
        resolve(m.type === 'welcome' ? (m.platform?.available ? 'ok' : 'Token accepted, but the Outrigger platform is off') : (m.message || 'Refused'));
      } catch { resolve('Unexpected reply'); }
    };
    ws.onclose = ev => { clearTimeout(t); resolve(ev.code === 1006 ? 'Token rejected or gateway unreachable' : 'Closed'); };
  });
}

document.getElementById('test').onclick = async () => {
  say('Testing…');
  const base = e.value.trim().replace(/\/$/, '');
  if (/^otr_/.test(k.value.trim())) {
    const r = await testToken(base, k.value.trim());
    return r === 'ok' ? say('Connected with token ✓', 'ok') : say(r, 'bad');
  }
  try {
    const r = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + k.value.trim() } });
    if (r.ok) say('Connected ✓', 'ok');
    else if (r.status === 401) say('Reached gateway, but key rejected (401)', 'bad');
    else say(`Gateway replied ${r.status}`, 'bad');
  } catch { say("Can't reach gateway", 'bad'); }
};
