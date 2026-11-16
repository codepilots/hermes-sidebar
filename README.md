# Hermes Sidebar

A Chromium side panel for asking Hermes (Sorrel) about the page you're reading.

## Install (unpacked)

1. Open `chrome://extensions`, turn on Developer mode.
2. Click "Load unpacked" and select this folder.
3. Open the extension's settings and paste your Hermes `API_SERVER_KEY`. The endpoint defaults to `http://127.0.0.1:8642`.

## How it works

- Opens as a side panel (default shortcut Alt+H, or the toolbar button).
- With "include page" on, it reads the current tab's text and selection and sends them with your question to the local gateway at `/v1/chat/completions`.
- The API key is stored in `chrome.storage.local`.
- The service worker strips the `Origin` header on calls to the local gateway, because the gateway rejects unknown origins with 403.

## Permissions

It requests `<all_urls>`, `tabs`, `scripting`, and `storage`. It can read any page you ask about, including logged-in pages. Turn off "include page" to stop page reads.

## License

MIT. See LICENSE.
