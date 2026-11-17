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
