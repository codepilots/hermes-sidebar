/* Firefox platform adapter (Manifest V2). Loaded before background-common.js
   (background page) and before browser-tools.js/panel.js (sidebar page).
   Firefox has no debugger/CDP, tabGroups or sidePanel API, so those are
   reimplemented here with tabs.executeScript, a messaging bridge, content-script
   hooks + webRequest, and sidebar_action. The shared code is unchanged. */

// DOM-aware replacer for run_js results (mirrors the Chrome CDP serializer).
const REPLACER = `function (k, x) {
  const node = n => n.nodeType === 1 ? n.outerHTML.slice(0, 2000) : String(n.textContent || '').slice(0, 2000);
  return x instanceof Node ? node(x)
    : (x instanceof NodeList || x instanceof HTMLCollection) ? Array.from(x).slice(0, 500)
    : x instanceof Map ? Object.fromEntries(x)
    : x instanceof Set ? Array.from(x)
    : typeof x === 'function' ? '[function ' + (x.name || 'anonymous') + ']'
    : typeof x === 'bigint' ? String(x)
    : x;
}`;

// dev_watch console/error capture must run in the page's MAIN world (a content
// script sandbox would not see the page's own console/errors). We inject a
// <script> element so the hook runs in the page; it buffers to window.__hermesDev
// and answers a postMessage read request. Caveat: pages with a strict script-src
// CSP block inline script injection, so console capture may be empty there;
// network capture (webRequest) is unaffected.
const DEV_HOOK_MAIN = function () {
  if (window.__hermesDev) return;
  var buf = { console: [], errors: [] };
  window.__hermesDev = buf;
  var cap = function (l, x) { if (l.length < 100) l.push(x); };
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var a = Array.prototype.slice.call(arguments);
      cap(buf.console, { level: level, text: a.map(function (x) {
        try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (_) { return String(x); }
      }).join(' ').slice(0, 500) });
      orig.apply(null, a);
    };
  });
  window.addEventListener('error', function (e) { cap(buf.errors, String(e.message || e.error || 'Error').slice(0, 800)); });
  window.addEventListener('unhandledrejection', function (e) { cap(buf.errors, String((e.reason && e.reason.message) || e.reason || 'Unhandled rejection').slice(0, 800)); });
  window.addEventListener('message', function (e) {
    if (e.source === window && e.data && e.data.__hermesDevRead) window.postMessage({ __hermesDevData: true, buf: buf }, '*');
  });
};
// Injected via tabs.executeScript (sandbox): drops the main-world hook into the page.
const DEV_HOOK_INJECT = '(function () { var s = document.createElement("script"); s.textContent = "(" + '
  + DEV_HOOK_MAIN.toString() + ' + ")();"; (document.head || document.documentElement).appendChild(s); s.remove(); })();';
// Read the buffer back: ask the main world via postMessage, resolve with the data.
const DEV_READ_BODY = 'new Promise(function (resolve) { var done = false; var finish = function (b) { if (done) return; done = true; window.removeEventListener("message", onMsg); resolve(b || { console: [], errors: [] }); }; var onMsg = function (e) { if (e.source === window && e.data && e.data.__hermesDevData) finish(e.data.buf); }; window.addEventListener("message", onMsg); window.postMessage({ __hermesDevRead: true }, "*"); setTimeout(function () { finish(window.__hermesDev); }, 1000); })';

const RESTRICTED = /^(about|moz-extension|chrome|devtools|view-source|resource):|^https:\/\/(addons\.mozilla\.org|chrome\.google\.com\/webstore)/;

function waitForLoadFF(tabId, ms) {
  return new Promise(resolve => {
    const done = ok => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(ok); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete' && t.url !== 'about:blank') done(true); }).catch(() => done(false));
  });
}

// Firefox tabs.executeScript does not await a returned promise, so run the async
// body in the page and post the result back via runtime.sendMessage.
function bridge(tabId, bodyExpr, useReplacer, signal) {
  return new Promise((resolve, reject) => {
    const id = 'hb-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const cleanup = () => { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The page did not answer (it may be navigating)')); }, 180000);
    const onMsg = (msg, sender) => {
      if (!msg || msg.__hermesBridge !== id) return;
      if (sender.tab && sender.tab.id !== tabId) return;
      cleanup();
      if (msg.error) reject(new Error(msg.error)); else resolve(msg.value);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    signal?.addEventListener('abort', () => { cleanup(); reject(new Error('Aborted')); }, { once: true });
    const repl = useReplacer ? REPLACER : 'null';
    const code = '(async () => { var id = ' + JSON.stringify(id) + '; try { var value = await (' + bodyExpr + ');'
      + ' var clean; try { clean = JSON.parse(JSON.stringify(value, ' + repl + ')); } catch (_) { clean = String(value); }'
      + ' chrome.runtime.sendMessage({ __hermesBridge: id, value: clean });'
      + ' } catch (e) { chrome.runtime.sendMessage({ __hermesBridge: id, error: String((e && e.message) || e) }); } })();';
    chrome.tabs.executeScript(tabId, { code, matchAboutBlank: false }).catch(e => { cleanup(); reject(e); });
  });
}

// Origin stripping state (background page only; blocking webRequest needs it).
let originHost = null;
let originListenerRegistered = false;
const extOrigin = chrome.runtime.getURL('');
function stripOrigin(details) {
  if (!originHost) return {};
  let h; try { h = new URL(details.url).host; } catch { return {}; }
  if (h !== originHost) return {};
  const fromExt = (details.originUrl || '').startsWith(extOrigin) || (details.documentUrl || '').startsWith(extOrigin);
  if (!fromExt) return {};
  return { requestHeaders: (details.requestHeaders || []).filter(x => x.name.toLowerCase() !== 'origin') };
}

globalThis.Platform = {
  name: 'firefox',

  isRestricted(url) { return RESTRICTED.test(url || ''); },

  async executeInPage(tabId, func, args = []) {
    const body = '(' + func.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')';
    return bridge(tabId, body, false);
  },

  async injectFile(tabId, file) {
    await chrome.tabs.executeScript(tabId, { file, matchAboutBlank: false });
  },

  // Arbitrary JS (expression or IIFE) via tabs.executeScript + the async bridge.
  async runJs(tabId, code, signal) {
    return bridge(tabId, '(' + code + ')', true, signal);
  },

  // Console/errors via an injected page hook; failed requests via webRequest.
  // Note: unlike Chrome's CDP, console/error capture starts after any reload
  // (the hook is re-injected once the page loads); network capture spans the
  // whole window.
  async devWatch(tabId, { seconds = 5, reload = false }, signal) {
    const out = { console: [], errors: [], failed_requests: [] };
    const cap = (l, x) => { if (l.length < 100) l.push(x); };
    const urls = new Map();
    const filter = { urls: ['<all_urls>'], tabId };
    const onReq = d => { if (d.tabId === tabId) urls.set(d.requestId, d.url); };
    const onComp = d => { if (d.tabId === tabId && d.statusCode >= 400) cap(out.failed_requests, { url: (d.url || '').slice(0, 300), status: d.statusCode }); };
    const onErr = d => { if (d.tabId === tabId && d.error !== 'net::ERR_ABORTED') cap(out.failed_requests, { url: (urls.get(d.requestId) || d.url || '').slice(0, 300), error: d.error }); };
    chrome.webRequest.onBeforeRequest.addListener(onReq, filter);
    chrome.webRequest.onCompleted.addListener(onComp, filter);
    chrome.webRequest.onErrorOccurred.addListener(onErr, filter);
    try {
      if (reload) { await chrome.tabs.reload(tabId); await waitForLoadFF(tabId, 15000); }
      await chrome.tabs.executeScript(tabId, { code: DEV_HOOK_INJECT, matchAboutBlank: false }).catch(() => {});
      await new Promise(r => { const tm = setTimeout(r, Math.min(Math.max(seconds, 1), 30) * 1000); signal?.addEventListener('abort', () => { clearTimeout(tm); r(); }, { once: true }); });
      const buf = await bridge(tabId, DEV_READ_BODY, false).catch(() => ({ console: [], errors: [] }));
      out.console = buf.console || []; out.errors = buf.errors || [];
    } finally {
      chrome.webRequest.onBeforeRequest.removeListener(onReq);
      chrome.webRequest.onCompleted.removeListener(onComp);
      chrome.webRequest.onErrorOccurred.removeListener(onErr);
    }
    return out;
  },

  // Firefox has no tab groups; opening the tab is enough.
  async groupTab() {},

  // sidebar_action's toolbar button toggles the panel; nothing to configure.
  setPanelBehavior() {},

  openPanel() { try { const sa = (typeof browser !== 'undefined' && browser.sidebarAction) || chrome.sidebarAction; if (sa && sa.open) sa.open(); } catch {} },

  // Strip Origin on this extension's gateway requests via blocking webRequest.
  // Registered in the background page (which also intercepts the sidebar's
  // own fetches, since they carry the extension origin).
  async syncOriginRule(endpoint, defaultEndpoint) {
    try { originHost = new URL(endpoint).host; } catch { originHost = new URL(defaultEndpoint).host; }
    if (!originListenerRegistered && chrome.webRequest && chrome.webRequest.onBeforeSendHeaders) {
      chrome.webRequest.onBeforeSendHeaders.addListener(stripOrigin, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
      originListenerRegistered = true;
    }
  },
};
