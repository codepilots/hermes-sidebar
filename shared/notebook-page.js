/* The full-tab note editor (notebook.html): the same Notebook mode as the side panel,
   on its own outrigger connection. It offers no browser tools (the panel does). */
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let opened = false;

function setStatus(cls, text) { $('status').className = 'status' + (cls ? ' ' + cls : ''); $('statusText').textContent = text; }

const prompts = createPrompts({
  host: () => $('notePrompts'),
  send: (chat, kind, id, value) => outrigger.chatAction(chat, kind, id, value),
  defaultChat: () => '',
});

const outrigger = new Outrigger({
  name: 'hermes-notebook-' + Math.random().toString(16).slice(2, 8),
  label: 'Hermes notes tab',
  tools: [],
  onCall: async () => ({ ok: false, error: 'This tab offers no browser tools' }),
  onStatus: state => setStatus(state === 'attached' ? '' : state === 'offline' ? 'err' : 'warn',
    { attached: 'Connected', connecting: 'Connecting…', offline: 'Offline', off: 'Not configured' }[state] || state),
  onDoc: m => NB.onFrame(m),
  onChat: m => {
    if (!m.chat_id || !NB.isNoteChat(m.chat_id)) return;
    if (prompts.handles(m.type)) return prompts.render(m);
    if (m.type === 'chat.action_result') return prompts.result(m);
    NB.onChat(m);
  },
  onWelcome: () => {
    if (!opened && params.get('root') && params.get('path')) { opened = true; NB.open(params.get('root'), params.get('path')); }
    else NB.reattach();
  },
});

NB.init();
chrome.storage.local.get(['endpoint', 'key']).then(({ endpoint = 'http://127.0.0.1:8642', key = '' }) => {
  if (!key) return setStatus('warn', 'No API key: set it in the extension settings');
  outrigger.start({ endpoint, key });
});
window.addEventListener('beforeunload', () => { NB.save().catch(() => {}); });
