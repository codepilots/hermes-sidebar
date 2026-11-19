/* Pins the decided behaviours from shared/docs/security-review.md:
   D1 (option c) — the API key is loopback-only; a remote gateway requires a
   paired otr_ token, in both the live connection and the settings test.
   D2 — the hello client identity follows the actual browser.
   Run: node --test tests/ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(here, '../shared/outrigger.js'), 'utf8');
const OPTIONS_SRC = readFileSync(path.join(here, '../shared/options.js'), 'utf8');

/* Load outrigger.js in a sandbox with a recording WebSocket stub. `platform`
   and `browserNS` control which identity signals exist in that context. */
function makeEnv({ platform, browserNS } = {}) {
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 1; this.sent = [];
      sockets.push(this);
    }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.readyState = 3; }
  }
  FakeWebSocket.OPEN = 1;
  const sandbox = {
    console, URL, setTimeout, clearTimeout,
    WebSocket: FakeWebSocket,
    chrome: { runtime: { getManifest: () => ({ version: '1.3' }) } },
    sockets,
  };
  if (platform) sandbox.Platform = platform;
  if (browserNS) sandbox.browser = browserNS;
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nglobalThis.Outrigger = Outrigger;', sandbox);
  return sandbox;
}

function client(env, extra = {}) {
  const states = [];
  const o = new env.Outrigger({
    tools: [],
    onCall: async () => ({ ok: true }),
    onStatus: (s, d) => states.push([s, d]),
    ...extra,
  });
  return { o, states };
}

const start = (o, endpoint, key) => o.start({ endpoint, key, sessionId: 's' });
// vm-created arrays fail deepStrictEqual across realms; compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x));

/* ---------- D1: credential policy on the live connection ---------- */

test('D1: remote endpoint + API key is refused before any socket is created', () => {
  const env = makeEnv({ platform: { name: 'chrome' } });
  const { o, states } = client(env);
  start(o, 'http://hermes.example.com:8642', 'sk-owner-key-123');
  assert.equal(env.sockets.length, 0);
  assert.equal(o.ws, null);
  const [state, detail] = states.at(-1);
  assert.equal(state, 'offline');
  assert.match(detail, /paired token/i);
  assert.equal(o.timer, 0, 'a policy refusal must not schedule retries');
});

test('D1: remote endpoint over plaintext ws:// + API key is refused', () => {
  const env = makeEnv();
  const { o } = client(env);
  start(o, 'http://192.168.1.50:8642', 'sk-owner-key-123');
  assert.equal(env.sockets.length, 0);
});

test('D1: remote endpoint + empty key is refused', () => {
  const env = makeEnv();
  const { o } = client(env);
  start(o, 'https://hermes.example.com', '');
  assert.equal(env.sockets.length, 0);
});

test('D1: remote endpoint + paired otr_ token connects with the token subprotocol', () => {
  const env = makeEnv();
  const { o } = client(env);
  start(o, 'https://hermes.example.com', 'otr_abc123');
  assert.equal(env.sockets.length, 1);
  assert.equal(env.sockets[0].url, 'wss://hermes.example.com/v1/outrigger/ws');
  assert.deepEqual(plain(env.sockets[0].protocols), ['hermes-outrigger.v1', 'bearer.otr_abc123']);
});

for (const endpoint of ['http://127.0.0.1:8642', 'http://localhost:8642', 'http://[::1]:8642']) {
  test(`D1: loopback endpoint ${endpoint} accepts the API key`, () => {
    const env = makeEnv();
    const { o } = client(env);
    start(o, endpoint, 'sk-owner-key-123');
    assert.equal(env.sockets.length, 1);
    assert.deepEqual(plain(env.sockets[0].protocols), ['hermes-outrigger.v1', 'bearer.sk-owner-key-123']);
  });
}

test('D1: changing settings to a compliant pair recovers from a refusal', () => {
  const env = makeEnv();
  const { o } = client(env);
  start(o, 'http://hermes.example.com:8642', 'sk-owner-key-123');
  assert.equal(env.sockets.length, 0);
  start(o, 'http://hermes.example.com:8642', 'otr_abc123');
  assert.equal(env.sockets.length, 1);
});

/* ---------- D1: the settings test-connection enforces the same policy ---------- */

test('D1: options testWS refuses remote + API key without a socket', async () => {
  // Extract testWS from options.js and run it against the stub socket.
  const m = OPTIONS_SRC.match(/function testWS\(base, key\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'testWS found in options.js');
  const sockets = [];
  class FakeWebSocket {
    constructor(url, protocols) { sockets.push({ url, protocols }); }
    close() {}
  }
  const sandbox = { WebSocket: FakeWebSocket, setTimeout, clearTimeout, console, Promise };
  vm.createContext(sandbox);
  vm.runInContext(m[0] + '\nglobalThis.testWS = testWS;', sandbox);
  const r = await sandbox.testWS('http://hermes.example.com:8642', 'sk-owner-key-123');
  assert.equal(r.ok, false);
  assert.match(r.msg, /paired token/i);
  assert.equal(sockets.length, 0);
  const r2 = await sandbox.testWS('http://127.0.0.1:8642', 'sk-owner-key-123');
  // loopback attempt proceeds to a socket (which never answers in this stub)
  assert.equal(sockets.length, 1);
  assert.ok(r2 === undefined || typeof r2 === 'object'); // resolves via timeout path only
});

/* ---------- D2: client identity follows the browser ---------- */

function helloOf(env, extra) {
  const { o } = client(env, extra);
  start(o, 'http://127.0.0.1:8642', 'k');
  const ws = env.sockets.at(-1);
  ws.onopen();
  return ws.sent.find(m => m.type === 'hello');
}

test('D2: Firefox adapter reports firefox-extension / Firefox sidebar', () => {
  const hello = helloOf(makeEnv({ platform: { name: 'firefox' } }));
  assert.equal(hello.client.kind, 'firefox-extension');
  assert.equal(hello.client.label, 'Firefox sidebar');
});

test('D2: Chrome adapter reports chromium-extension / Chromium side panel', () => {
  const hello = helloOf(makeEnv({ platform: { name: 'chrome' } }));
  assert.equal(hello.client.kind, 'chromium-extension');
  assert.equal(hello.client.label, 'Chromium side panel');
});

test('D2: notebook page (no Platform adapter) detects Firefox via browser.*', () => {
  const env = makeEnv({ browserNS: { runtime: { getURL: () => 'moz-extension://x/' } } });
  const hello = helloOf(env, { label: 'Hermes notes tab' });
  assert.equal(hello.client.kind, 'firefox-extension');
  assert.equal(hello.client.label, 'Hermes notes tab', 'explicit labels are preserved');
});

test('D2: no Platform and no browser.* falls back to Chromium identity', () => {
  const hello = helloOf(makeEnv());
  assert.equal(hello.client.kind, 'chromium-extension');
});
