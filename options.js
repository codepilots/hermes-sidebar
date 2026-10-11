const e = document.getElementById('endpoint'), k = document.getElementById('key'), st = document.getElementById('st');
const say = (t, cls = '') => { st.textContent = t; st.className = cls; };
chrome.storage.local.get(['endpoint', 'key']).then(v => { e.value = v.endpoint || 'http://127.0.0.1:8642'; k.value = v.key || ''; });

document.getElementById('reveal').onclick = () => { k.type = k.type === 'password' ? 'text' : 'password'; };

async function save() {
  await chrome.storage.local.set({ endpoint: e.value.trim().replace(/\/$/, ''), key: k.value.trim() });
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
