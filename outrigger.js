/* Outrigger client: attaches this sidebar to a Hermes session so Hermes can call
   browser tools during a turn. Talks to the hermes-outrigger gateway plugin over
   a WebSocket (protocol v1, see hermes-outrigger docs/spec.md section 7).

   Browsers cannot set headers on a WebSocket, so the API key travels as the
   subprotocol "bearer.<key>"; the server selects "hermes-outrigger.v1". */

class Outrigger {
  /**
   * @param {object} o
   * @param {Array}    o.tools     ToolDecl list sent in hello
   * @param {Function} o.onCall    async ({call_id, tool, args, deadline_ms, signal}) => {ok, content?, error?}
   * @param {Function} o.onCancel  (call_id, reason) => void
   * @param {Function} o.onStatus  (state, detail) => void; state: off|connecting|attached|offline
   * @param {Function} o.onChat    (frame) => void for Outrigger-platform chat.* frames
   * @param {Function} o.onWelcome (welcome) => void, after every (re)attach
   */
  constructor({ tools, onCall, onCancel, onStatus, onChat, onWelcome, onDoc, name = 'hermes-sidebar', label = 'Chromium side panel' }) {
    Object.assign(this, { tools, onCall, onCancel, onStatus, onChat, onWelcome, onDoc, name, label });
    this.platformAvailable = false;
    this.ws = null; this.cfg = null; this.stopped = true;
    this.attached = false; this.retry = 0; this.timer = 0; this.summary = '';
    this.inflight = new Map();   // call_id -> AbortController
    this.waiters = [];           // resolvers for ready()
  }

  start({ endpoint, key, sessionId }) {
    this.stop();
    this.cfg = { endpoint, key, sessionId }; this.stopped = false; this.retry = 0;
    this._connect();
  }

  stop() {
    this.stopped = true; clearTimeout(this.timer);
    if (this.ws) { try { this.ws.close(1000); } catch {} }
    this.ws = null; this._detach();
    this._status('off');
  }

  /** New conversation: point the existing connection at another session id. */
  bind(sessionId) {
    if (!this.cfg) return;
    this.cfg.sessionId = sessionId;
    if (this.attached) this._send({ type: 'bind', session_id: sessionId });
  }

  /** One-line live context shown to the model (current tab). */
  setContext(summary) {
    this.summary = summary;
    if (this.attached) this._send({ type: 'context.update', summary });
  }

  /** Resolves true once attached, or false after ms. */
  ready(ms = 2000) {
    if (this.attached) return Promise.resolve(true);
    if (this.stopped) return Promise.resolve(false);
    return new Promise(res => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== done); res(false); }, ms);
      const done = ok => { clearTimeout(t); res(ok); };
      this.waiters.push(done);
    });
  }

  /* ---------- internals ---------- */
  _status(state, detail = '') { this.state = state; try { this.onStatus?.(state, detail); } catch {} }

  _connect() {
    const { endpoint, key } = this.cfg;
    const url = endpoint.replace(/\/$/, '').replace(/^http/, 'ws') + '/v1/outrigger/ws';
    this._status('connecting');
    let ws;
    try { ws = new WebSocket(url, ['hermes-outrigger.v1', 'bearer.' + key]); }
    catch (e) { this._status('offline', e.message); return this._schedule(); }
    this.ws = ws;
    ws.onopen = () => this._send({
      // Protocol 2 adds the Outrigger platform: chat through Hermes's messaging pipeline.
      type: 'hello', protocol: 2, capabilities: ['chat', 'edits', 'model_picker', 'choices', 'clarify', 'approvals', 'media', 'notebook'],
      client: { name: this.name, version: chrome.runtime.getManifest().version,
                kind: 'chromium-extension', label: this.label, concurrency: 1 },
      session_id: this.cfg.sessionId, tools: this.tools,
      ...(this.redaction ? { redaction: this.redaction } : {}),
    });
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } this._onMessage(m); };
    ws.onclose = ev => {
      if (this.ws !== ws) return;          // superseded by a newer socket
      this.ws = null; this._detach();
      if (this.stopped) return;
      // A refused handshake (bad key, plugin not loaded, gateway down) looks the same: 1006.
      this._status('offline', ev.code === 1006 ? 'Gateway unreachable, plugin not enabled, or key rejected' : (ev.reason || 'Disconnected'));
      this._schedule();
    };
  }

  _schedule() {
    if (this.stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** this.retry++);
    clearTimeout(this.timer); this.timer = setTimeout(() => this._connect(), delay);
  }

  _detach() {
    this.attached = false;
    for (const [id, ac] of this.inflight) { ac.abort(); try { this.onCancel?.(id, 'disconnected'); } catch {} }
    this.inflight.clear();
  }

  /** Outrigger platform: send a message (or slash command) to a chat. */
  chatSend(chatId, text, clientMsgId) { this._send({ type: 'chat.send', chat_id: chatId, text, client_msg_id: clientMsgId }); }
  chatStop(chatId) { this._send({ type: 'chat.stop', chat_id: chatId }); }
  chatAttach(chatId) { this._send({ type: 'chat.attach', chat_id: chatId }); }
  requestCommands() { this._send({ type: 'chat.commands' }); }
  chatAction(chatId, kind, id, value) { this._send({ type: 'chat.action', chat_id: chatId, kind, id, value }); }

  _send(m) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  _onMessage(m) {
    switch (m.type) {
      case 'welcome':
        this.attached = true; this.retry = 0; this.clientId = m.client_id;
        this.platformAvailable = !!(m.platform && m.platform.available);
        this._status('attached');
        try { this.onWelcome?.(m); } catch {}
        if (this.summary) this._send({ type: 'context.update', summary: this.summary });
        this.waiters.splice(0).forEach(w => w(true));
        break;
      case 'ping':
        this._send({ type: 'pong' });
        break;
      case 'call':
        this._runCall(m);
        break;
      case 'cancel': {
        const ac = this.inflight.get(m.call_id);
        if (ac) { ac.abort(); this.inflight.delete(m.call_id); }
        try { this.onCancel?.(m.call_id, m.reason); } catch {}
        break;
      }
      case 'error':
        console.warn('outrigger:', m.code, m.message);
        try { this.onChat?.(m); } catch {}
        break;
      default:
        if (typeof m.type === 'string' && m.type.startsWith('chat.')) { try { this.onChat?.(m); } catch {} }
        else if (typeof m.type === 'string' && m.type.startsWith('doc.')) { try { this.onDoc?.(m); } catch (e) { console.warn(e); } }
    }
  }

  async _runCall(m) {
    const ac = new AbortController();
    this.inflight.set(m.call_id, ac);
    let res;
    try {
      res = await this.onCall({ ...m, signal: ac.signal });
    } catch (e) {
      res = { ok: false, error: String(e && e.message || e) };
    }
    if (!this.inflight.has(m.call_id)) return;   // cancelled or disconnected meanwhile
    this.inflight.delete(m.call_id);
    this._send({ type: 'result', call_id: m.call_id, ...res });
  }
}
