/* Shared background logic for both browsers. Browser-specific behaviour
   (panel open/behaviour, Origin-header stripping) lives in platform.js,
   which is loaded before this file. See chrome/ and firefox/.
   Audit: see AUDIT.md#origin-strip (rule lifecycle) and AUDIT.md#context-menu.
   syncOriginRule registers the strip rule at startup and re-registers it whenever
   the endpoint setting changes, so the rule always follows the configured gateway. */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8642';

// Hermes api_server rejects unknown Origins (403). Strip Origin only on this
// extension's own requests to the configured gateway (HTTP and the outrigger
// WebSocket). The rule follows the endpoint setting, so a remote gateway works.
async function syncOriginRule() {
  const { endpoint = DEFAULT_ENDPOINT } = await chrome.storage.local.get('endpoint');
  await Platform.syncOriginRule(endpoint, DEFAULT_ENDPOINT);
}

Platform.setPanelBehavior();
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
  // Open the panel inside the click's user gesture: call it first.
  Platform.openPanel(tab.windowId);
  const kind = info.menuItemId.replace('ask-', '');
  chrome.storage.session.set({ pendingAsk: {
    kind, windowId: tab.windowId, ts: Date.now(), pageUrl: info.pageUrl, title: tab.title,
    text: kind === 'selection' ? info.selectionText : undefined,
    url: kind === 'link' ? info.linkUrl : kind === 'image' ? info.srcUrl : undefined,
  } });
});
