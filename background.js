chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
// Hermes api_server rejects unknown Origins (403). Strip Origin only on this extension's own calls to the local gateway,
// including the outrigger WebSocket that lets Hermes call browser tools.
chrome.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1],addRules:[{id:1,priority:1,
  action:{type:"modifyHeaders",requestHeaders:[{header:"origin",operation:"remove"}]},
  condition:{regexFilter:"^(https?|wss?)://(127\\.0\\.0\\.1|localhost):8642/",initiatorDomains:[chrome.runtime.id],resourceTypes:["xmlhttprequest","websocket","other"]}}]});
