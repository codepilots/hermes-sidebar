const e = document.getElementById('endpoint'), k = document.getElementById('key'), st = document.getElementById('st'), bt = document.getElementById('browserTools'), ra = document.getElementById('reviewerAuto');
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
chrome.storage.local.get(['endpoint', 'key', 'browserTools', 'reviewerAuto', 'redact', 'redactCats', 'redactSkip']).then(v => {
  e.value = v.endpoint || 'http://127.0.0.1:8642'; k.value = v.key || ''; bt.checked = v.browserTools !== false; ra.checked = v.reviewerAuto !== false;
  rd.checked = v.redact !== false;
  cats.querySelectorAll('input').forEach(cb => { if (v.redactCats && cb.dataset.cat in v.redactCats) cb.checked = !!v.redactCats[cb.dataset.cat]; });
  skip.value = (v.redactSkip || []).join('\n');
  syncCats();
});

document.getElementById('reveal').onclick = () => { k.type = k.type === 'password' ? 'text' : 'password'; };

async function save() {
  await chrome.storage.local.set({ endpoint: e.value.trim().replace(/\/$/, ''), key: k.value.trim(), browserTools: bt.checked, reviewerAuto: ra.checked,
    redact: rd.checked,
    redactCats: Object.fromEntries([...cats.querySelectorAll('input')].map(cb => [cb.dataset.cat, cb.checked])),
    redactSkip: skip.value.split(/\s+/).map(h => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()).filter(Boolean) });
  say('Saved ✓', 'ok');
}
document.getElementById('save').onclick = save;
[e, k].forEach(i => i.addEventListener('keydown', ev => { if (ev.key === 'Enter') save(); }));

document.getElementById('test').onclick = async () => {
  say('Testing…');
  const base = e.value.trim().replace(/\/$/, '');
  try {
    const r = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + k.value.trim() } });
    if (r.ok) say('Connected ✓', 'ok');
    else if (r.status === 401) say('Reached gateway, but key rejected (401)', 'bad');
    else say(`Gateway replied ${r.status}`, 'bad');
  } catch { say("Can't reach gateway", 'bad'); }
};
