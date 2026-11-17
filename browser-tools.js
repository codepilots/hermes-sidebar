/* Browser tools offered to Hermes through the outrigger connection.
   policy "auto" runs without asking; "confirm" needs the user's Allow in the panel. */

const BROWSER_TOOLS = [
  { name: 'get_page', policy: 'auto',
    description: 'Title, URL, selection and visible text of the active tab (or tab id)',
    parameters: { type: 'object', additionalProperties: false, properties: {
      max_chars: { type: 'integer', minimum: 100, maximum: 60000, description: 'Default 20000' },
      tab: { type: 'integer', description: 'Tab id from list_tabs' } } } },
  { name: 'get_selection', policy: 'auto',
    description: "The text the user has selected in the current tab",
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'list_tabs', policy: 'auto',
    description: 'Tabs in this window: id, title, URL, active',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'run_js', policy: 'confirm', timeout_s: 180,
    description: "Last resort (needs approval): run JS in the page, value returned as JSON. To read or check the page use get_page or snapshot instead.",
    parameters: { type: 'object', additionalProperties: false, required: ['code'], properties: {
      code: { type: 'string', description: 'An expression or IIFE; for await use (async () => { ... })()' },
      tab: { type: 'integer' } } } },
  { name: 'snapshot', policy: 'auto',
    description: 'Outline of the page: links, buttons, fields, headings with refs like e14 (incl. shadow DOM). Use refs in click/fill/scroll/wait_for. text=true adds text lines.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'string', description: 'Only this element\'s subtree' }, selector: { type: 'string' },
      text: { type: 'boolean' }, max_items: { type: 'integer', minimum: 20, maximum: 1000 }, tab: { type: 'integer' } } } },
  { name: 'scroll', policy: 'auto',
    description: 'Scroll a screen, to top/bottom or to an element; waits for lazy content, says if the page grew.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      to: { type: 'string', enum: ['top', 'bottom'] }, ref: { type: 'string' }, selector: { type: 'string' },
      by: { type: 'integer', description: 'Pixels; negative scrolls up' }, wait_ms: { type: 'integer', minimum: 0, maximum: 5000 },
      tab: { type: 'integer' } } } },
  { name: 'wait_for', policy: 'auto',
    description: 'Wait (up to 15 s) until text or an element appears, or disappears with gone=true.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      text: { type: 'string' }, ref: { type: 'string' }, selector: { type: 'string' }, gone: { type: 'boolean' },
      timeout_ms: { type: 'integer', minimum: 100, maximum: 15000 }, tab: { type: 'integer' } } } },
  { name: 'fetch_as_user', policy: 'auto',
    description: "GET a URL on the tab's own site with the user's cookies; returns readable text (HTML) or JSON. Same site only.",
    parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: {
      url: { type: 'string', description: 'Absolute or relative to the tab' },
      max_chars: { type: 'integer', minimum: 200, maximum: 60000 }, tab: { type: 'integer' } } } },
  { name: 'click', policy: 'confirm', timeout_s: 180,
    description: 'Click an element by ref (from snapshot) or CSS selector.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'string' }, selector: { type: 'string' }, tab: { type: 'integer' } } } },
  { name: 'fill', policy: 'confirm', timeout_s: 180,
    description: 'Set one input, textarea, select or checkbox by ref or selector.',
    parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, tab: { type: 'integer' } } } },
  { name: 'fill_form', policy: 'confirm', timeout_s: 180,
    description: 'Fill fields [{ref|selector, value}] and optionally click submit {ref|selector}, under one approval.',
    parameters: { type: 'object', additionalProperties: false, required: ['fields'], properties: {
      fields: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', additionalProperties: false,
        required: ['value'], properties: { ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } } } },
      submit: { type: 'object', additionalProperties: false, properties: { ref: { type: 'string' }, selector: { type: 'string' } } },
      tab: { type: 'integer' } } } },
  { name: 'highlight', policy: 'auto',
    description: 'Show the user something: outline an element (ref/selector) or highlight text for a few seconds.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' },
      seconds: { type: 'integer', minimum: 1, maximum: 30 }, tab: { type: 'integer' } } } },
  { name: 'switch_tab', policy: 'auto', description: 'Bring a tab (id from list_tabs) to the front.',
    parameters: { type: 'object', additionalProperties: false, required: ['tab'], properties: { tab: { type: 'integer' } } } },
  { name: 'close_tab', policy: 'auto', description: 'Close a tab that Hermes opened with open_url (other tabs are refused).',
    parameters: { type: 'object', additionalProperties: false, required: ['tab'], properties: { tab: { type: 'integer' } } } },
  { name: 'screenshot', policy: 'confirm', timeout_s: 180,
    description: 'Capture the visible part of the active tab; returns an image_path to open with vision_analyze. Screenshots are not redacted.',
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'dev_watch', policy: 'confirm', timeout_s: 180,
    description: "Collect the tab's console messages, errors and failed requests for N seconds (optional reload).",
    parameters: { type: 'object', additionalProperties: false, properties: {
      seconds: { type: 'integer', minimum: 1, maximum: 30 }, reload: { type: 'boolean' }, tab: { type: 'integer' } } } },
  { name: 'search_history', policy: 'confirm', timeout_s: 180,
    description: "Search the user's browsing history (title/URL text).",
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string' }, days: { type: 'integer', minimum: 1, maximum: 365 }, max: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'search_bookmarks', policy: 'confirm', timeout_s: 180, description: "Search the user's bookmarks.",
    parameters: { type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string' }, max: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'reveal', policy: 'confirm', timeout_s: 180,
    description: 'Real values for ⟦…⟧ placeholders, only for tasks outside this browser; user approves each reveal.',
    parameters: { type: 'object', additionalProperties: false, required: ['placeholders', 'purpose'], properties: {
      placeholders: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
      purpose: { type: 'string', description: 'What the values are for; shown to the user' } } } },
  { name: 'open_url', policy: 'confirm', timeout_s: 180,
    description: 'Open an http(s) URL in a new tab (default) or this tab, wait for load; it becomes the active tab.',
    parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: {
      url: { type: 'string' }, new_tab: { type: 'boolean' } } } },
];

const BROWSER_TOOL_POLICY = Object.fromEntries(BROWSER_TOOLS.map(t => [t.name, t.policy]));

// Approval classes for "confirm" tools. Grants and reviewer auto-approval work per class.
const TOOL_CLASS = { click: 'act', fill: 'act', fill_form: 'act', open_url: 'navigate', run_js: 'code', fetch_as_user: 'navigate', reveal: 'reveal',
  screenshot: 'capture', dev_watch: 'debug', search_history: 'personal', search_bookmarks: 'personal' };
const CLASS_LABEL = { act: 'page actions', navigate: 'opening pages', code: 'running code', reveal: 'revealing data',
  capture: 'screenshots', debug: 'debugging', personal: 'history and bookmarks' };
// Classes that never get a per-site grant: they reach beyond one site.
const NO_GRANT_CLASSES = new Set(['reveal', 'personal']);
// Tools that need an optional permission; offered only once it is granted.
const OPTIONAL_TOOL_PERMISSION = { search_history: 'history', search_bookmarks: 'bookmarks' };
// Tabs Hermes opened (open_url): the only ones close_tab may close.
const hermesTabs = new Set();
// Classes Hermes's reviewer may approve without a card. Code always needs the user
// (or a grant): it runs with the user's cookies, the main exfiltration risk.
const REVIEWER_CLASSES = new Set(['act', 'navigate']);

const RESTRICTED = /^(chrome|edge|brave|about|devtools|chrome-extension|view-source):|^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

async function targetTab(id) {
  const t = Number.isInteger(id)
    ? await chrome.tabs.get(id).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t) throw new Error(Number.isInteger(id) ? `No tab with id ${id}` : 'No active tab');
  if (!t.url || RESTRICTED.test(t.url)) throw new Error(`Browser pages like ${t.url || 'this one'} cannot be scripted`);
  return t;
}

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

function waitForLoad(tabId, ms) {
  return new Promise(resolve => {
    const done = ok => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpd); resolve(ok); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
    const timer = setTimeout(() => done(false), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    // It may already be complete (cached page) before the listener was added.
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete' && t.url !== 'about:blank') done(true); }).catch(() => done(false));
  });
}

async function inPage(tabId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return r.result;
}

// Call a page-agent.js method in the tab (injected on demand into the extension's
// isolated world, where element refs are kept).
async function agent(tabId, method, ...args) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['page-agent.js'] });
  const r = await inPage(tabId, async (m, a) => {
    try { return { ok: true, value: await globalThis.__hermes[m](...a) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }, [method, args]);
  if (!r) throw new Error('The page did not answer (it may be navigating)');
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const target = ({ ref, selector }) => ({ ref, selector });

const BROWSER_HANDLERS = {
  async get_page({ max_chars = 20000, tab }) {
    const t = await targetTab(tab);
    const r = await inPage(t.id, max => {
      const text = document.body ? document.body.innerText : '';
      return { selection: String(getSelection()), text: text.slice(0, max), truncated: text.length > max };
    }, [max_chars]);
    return { tab: t.id, title: t.title, url: t.url, ...r };
  },

  async get_selection() {
    const t = await targetTab();
    return { tab: t.id, url: t.url, selection: await inPage(t.id, () => String(getSelection())) };
  },

  async list_tabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
  },

  async run_js({ code, tab }, { signal }) {
    const t = await targetTab(tab);
    const target = { tabId: t.id };
    try { await chrome.debugger.attach(target, '1.3'); }
    catch (e) { throw new Error('Could not attach to the tab (DevTools open on it?): ' + e.message); }
    const detach = () => chrome.debugger.detach(target).catch(() => {});
    signal?.addEventListener('abort', detach, { once: true });
    const cdp = (method, params) => chrome.debugger.sendCommand(target, method, params);
    try {
      // No replMode: in REPL mode a returned promise is handed back unresolved
      // (like the DevTools console), so awaitPromise would yield "{}".
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
      // Objects: serialize in the page so DOM nodes, NodeLists, Maps and Sets come back readable.
      const s = await cdp('Runtime.callFunctionOn', {
        objectId: v.objectId, returnByValue: true, functionDeclaration: SERIALIZE_IN_PAGE,
      });
      return s.result.value;
    } finally {
      await cdp('Runtime.releaseObjectGroup', { objectGroup: 'hermes' }).catch(() => {});
      await detach();
    }
  },

  async snapshot({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'snapshot', opts);
  },

  async scroll({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'scroll', opts);
  },

  async wait_for({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'waitFor', opts);
  },

  async fetch_as_user({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'fetchAsUser', opts);
  },

  async click({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'click', target(opts));
  },

  async fill({ tab, text, ...opts }) {
    return agent((await targetTab(tab)).id, 'fill', target(opts), text);
  },

  async fill_form({ tab, fields, submit }) {
    return agent((await targetTab(tab)).id, 'fillForm', fields, submit || null);
  },

  async highlight({ tab, ...opts }) {
    return agent((await targetTab(tab)).id, 'highlight', opts);
  },

  async switch_tab({ tab }) {
    const t = await chrome.tabs.get(tab).catch(() => null);
    if (!t) throw new Error(`No tab with id ${tab}`);
    await chrome.tabs.update(tab, { active: true });
    await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    return { tab, title: t.title, url: t.url };
  },

  async close_tab({ tab }) {
    if (!hermesTabs.has(tab)) throw new Error('Only tabs Hermes opened with open_url can be closed');
    await chrome.tabs.remove(tab).catch(() => {});
    hermesTabs.delete(tab);
    return { closed: tab };
  },

  async screenshot() {
    const t = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!t || !t.url || RESTRICTED.test(t.url)) throw new Error('This page cannot be captured');
    const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
    // The plugin saves it and gives Hermes a path for vision_analyze.
    return { tab: t.id, url: t.url, title: t.title, image: { mime: 'image/png', data: dataUrl.split(',', 2)[1] } };
  },

  async dev_watch({ seconds = 5, reload = false, tab }, { signal }) {
    const t = await targetTab(tab);
    const target = { tabId: t.id };
    try { await chrome.debugger.attach(target, '1.3'); }
    catch (e) { throw new Error('Could not attach to the tab (DevTools open on it?): ' + e.message); }
    const out = { console: [], errors: [], failed_requests: [] };
    const cap = (list, item) => { if (list.length < 100) list.push(item); };
    const fmt = args => (args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 500);
    const urls = new Map();
    const onEvent = (src, method, p) => {
      if (src.tabId !== t.id) return;
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
    return { url: t.url, watched_seconds: seconds, reloaded: !!reload, ...out };
  },

  async search_history({ query, days = 30, max = 20 }) {
    if (!chrome.history) throw new Error('History access is off (enable it in the sidebar settings)');
    const items = await chrome.history.search({ text: query, startTime: Date.now() - days * 864e5, maxResults: max });
    return items.map(i => ({ title: i.title, url: i.url, last_visit: new Date(i.lastVisitTime).toISOString(), visits: i.visitCount }));
  },

  async search_bookmarks({ query, max = 20 }) {
    if (!chrome.bookmarks) throw new Error('Bookmark access is off (enable it in the sidebar settings)');
    return (await chrome.bookmarks.search(query)).filter(b => b.url).slice(0, max).map(b => ({ title: b.title, url: b.url }));
  },

  async open_url({ url, new_tab = true }) {
    let u;
    try { u = new URL(url); } catch { throw new Error('Not a valid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs can be opened');
    const t = new_tab
      ? await chrome.tabs.create({ url: u.href, active: true })
      : await chrome.tabs.update((await chrome.tabs.query({ active: true, currentWindow: true }))[0].id, { url: u.href });
    if (new_tab) {
      hermesTabs.add(t.id);
      // Keep Hermes's tabs together and easy to close.
      try {
        const [g] = await chrome.tabGroups.query({ title: 'Hermes', windowId: t.windowId });
        const gid = await chrome.tabs.group({ tabIds: [t.id], ...(g ? { groupId: g.id } : { createProperties: { windowId: t.windowId } }) });
        if (!g) await chrome.tabGroups.update(gid, { title: 'Hermes', color: 'orange' });
      } catch {}
    }
    // Return once the page has loaded, so a following get_page reads the new page.
    const loaded = await waitForLoad(t.id, 20000);
    const now = await chrome.tabs.get(t.id);
    return { tab: t.id, url: now.url, title: now.title, loaded };
  },
};
