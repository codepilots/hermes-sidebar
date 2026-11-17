chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Hermes api_server rejects unknown Origins (403). Strip Origin only on this extension's
// own requests to the configured gateway (HTTP and the outrigger WebSocket). The rule
// follows the endpoint setting, so a remote gateway (e.g. with an outrigger token) works.
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function syncOriginRule() {
  const { endpoint = DEFAULT_ENDPOINT } = await chrome.storage.local.get('endpoint');
  let host;
  try { host = new URL(endpoint).host; } catch { host = new URL(DEFAULT_ENDPOINT).host; }
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: { regexFilter: `^(https?|wss?)://${esc(host)}/`, initiatorDomains: [chrome.runtime.id],
                 resourceTypes: ['xmlhttprequest', 'websocket', 'other'] },
  }] });
}
syncOriginRule();
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.endpoint) syncOriginRule(); });

// Right-click "Ask Hermes…" (proposal 4): open the panel and hand it the item.
const MENUS = [
  ['ask-selection', 'Ask Hermes about the selection', ['selection']],
  ['ask-link', 'Ask Hermes about this link', ['link']],
  ['ask-image', 'Ask Hermes about this image', ['image']],
  ['ask-page', 'Ask Hermes about this page', ['page']],
];
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => MENUS.forEach(([id, title, contexts]) => chrome.contextMenus.create({ id, title, contexts })));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  // sidePanel.open must run inside the click's user gesture: call it first.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const kind = info.menuItemId.replace('ask-', '');
  chrome.storage.session.set({ pendingAsk: {
    kind, windowId: tab.windowId, ts: Date.now(), pageUrl: info.pageUrl, title: tab.title,
    text: kind === 'selection' ? info.selectionText : undefined,
    url: kind === 'link' ? info.linkUrl : kind === 'image' ? info.srcUrl : undefined,
  } });
});
