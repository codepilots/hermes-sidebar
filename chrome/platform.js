/* Chrome/Chromium platform adapter. Loaded before background-common.js (in the
   service worker) and before browser-tools.js/panel.js (in the panel page).
   Implements the browser-specific primitives the shared code calls via Platform.
   Audit: see AUDIT.md#origin-strip (DNR rule) and AUDIT.md#browser-adapters.
   Security-relevant here: the declarativeNetRequest rule strips Origin ONLY on
   this extension's own requests (initiatorDomains) to the configured gateway
   host; isRestricted marks pages that must never be scripted/captured; run_js
   and dev_watch attach the debugger to the target tab only. */

// Runs in the page with `this` = run_js's result object; returns plain JSON data.
const SERIALIZE_IN_PAGE = `function () {
  const node = n => n.nodeType === 1 ? n.outerHTML.slice(0, 2000) : String(n.textContent || '').slice(0, 2000);
  const replacer = (k, x) =>
    x instanceof Node ? node(x)
    : (x instanceof NodeList || x instanceof HTMLCollection) ? Array.from(x).slice(0, 500)
    : x instanceof Map ? Object.fromEntries(x)
    : x instanceof Set ? Array.from(x)
    : typeof x === 'function' ? '[function ' + (x.name || 'anonymous') + ']'
    : typeof x === 'bigint' ? String(x)
    : x;
  try { return JSON.parse(JSON.stringify(this, replacer)); }
  catch (e) { return String(this); }
}`;

const RESTRICTED = /^(chrome|edge|brave|about|devtools|chrome-extension|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

globalThis.Platform = {
  name: 'chrome',

  isRestricted(url) { return RESTRICTED.test(url || ''); },

  async executeInPage(tabId, func, args = []) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r.result;
  },

  async injectFile(tabId, file) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
  },

  // Arbitrary JS via the debugger (CDP): awaits promises, serializes DOM/objects.
  async runJs(tabId, code, signal) {
    const target = { tabId };
    try { await chrome.debugger.attach(target, '1.3'); }
    catch (e) { throw new Error('Could not attach to the tab (DevTools open on it?): ' + e.message); }
    const detach = () => chrome.debugger.detach(target).catch(() => {});
    signal?.addEventListener('abort', detach, { once: true });
    const cdp = (method, params) => chrome.debugger.sendCommand(target, method, params);
    try {
      const r = await cdp('Runtime.evaluate', {
        expression: code, awaitPromise: true, returnByValue: false, userGesture: true, objectGroup: 'hermes',
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text || 'Exception');
      }
      const v = r.result;
      if (v.type === 'undefined') return null;
      if (!v.objectId) return v.value !== undefined ? v.value : (v.unserializableValue || v.description);
      const s = await cdp('Runtime.callFunctionOn', {
        objectId: v.objectId, returnByValue: true, functionDeclaration: SERIALIZE_IN_PAGE,
      });
      return s.result.value;
    } finally {
      await cdp('Runtime.releaseObjectGroup', { objectGroup: 'hermes' }).catch(() => {});
      await detach();
    }
  },

  // Console/errors/failed requests via CDP events.
  async devWatch(tabId, { seconds = 5, reload = false }, signal) {
    const target = { tabId };
    try { await chrome.debugger.attach(target, '1.3'); }
    catch (e) { throw new Error('Could not attach to the tab (DevTools open on it?): ' + e.message); }
    const out = { console: [], errors: [], failed_requests: [] };
    const cap = (list, item) => { if (list.length < 100) list.push(item); };
    const fmt = args => (args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 500);
    const urls = new Map();
    const onEvent = (src, method, p) => {
      if (src.tabId !== tabId) return;
      if (method === 'Runtime.consoleAPICalled') cap(out.console, { level: p.type, text: fmt(p.args) });
      else if (method === 'Runtime.exceptionThrown') cap(out.errors, (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'Error').slice(0, 800));
      else if (method === 'Log.entryAdded' && p.entry.level !== 'verbose') cap(out.console, { level: p.entry.level, text: (p.entry.text || '').slice(0, 500), source: p.entry.source });
      else if (method === 'Network.requestWillBeSent') urls.set(p.requestId, p.request.url);
      else if (method === 'Network.responseReceived' && p.response.status >= 400) cap(out.failed_requests, { url: p.response.url.slice(0, 300), status: p.response.status });
      else if (method === 'Network.loadingFailed' && !p.canceled) cap(out.failed_requests, { url: (urls.get(p.requestId) || '').slice(0, 300), error: p.errorText });
    };
    chrome.debugger.onEvent.addListener(onEvent);
    const cdp = (m, prm) => chrome.debugger.sendCommand(target, m, prm);
    try {
      await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable');
      if (reload) await cdp('Page.reload', { ignoreCache: false });
      await new Promise(r => { const tm = setTimeout(r, Math.min(Math.max(seconds, 1), 30) * 1000); signal?.addEventListener('abort', () => { clearTimeout(tm); r(); }, { once: true }); });
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      await chrome.debugger.detach(target).catch(() => {});
    }
    return out;
  },

  // Keep Hermes's tabs together in a named tab group.
  async groupTab(t) {
    try {
      const [g] = await chrome.tabGroups.query({ title: 'Hermes', windowId: t.windowId });
      const gid = await chrome.tabs.group({ tabIds: [t.id], ...(g ? { groupId: g.id } : { createProperties: { windowId: t.windowId } }) });
      if (!g) await chrome.tabGroups.update(gid, { title: 'Hermes', color: 'orange' });
    } catch {}
  },

  setPanelBehavior() { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); },

  openPanel(windowId) { chrome.sidePanel.open({ windowId }).catch(() => {}); },

  // Strip Origin on this extension's requests to the gateway via declarativeNetRequest.
  async syncOriginRule(endpoint, defaultEndpoint) {
    let host;
    try { host = new URL(endpoint).host; } catch { host = new URL(defaultEndpoint).host; }
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [{
      id: 1, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { regexFilter: `^(https?|wss?)://${esc(host)}/`, initiatorDomains: [chrome.runtime.id],
                   resourceTypes: ['xmlhttprequest', 'websocket', 'other'] },
    }] });
  },
};
