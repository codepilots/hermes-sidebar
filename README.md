# Hermes Sidebar

A Chromium side panel for asking Hermes (Sorrel) about the page you're reading.

## Install (unpacked)

1. Open `chrome://extensions`, turn on Developer mode.
2. Click "Load unpacked" and select this folder.
3. Open the extension's settings and paste your Hermes `API_SERVER_KEY`, or a client token from `hermes outrigger pair --user <id>` (`otr_…`; chat then goes only through the Outrigger platform, as that user). The endpoint defaults to `http://127.0.0.1:8642`; a remote gateway works too (the Origin rule follows the endpoint).

## How it works

- Opens as a side panel (default shortcut Alt+H, or the toolbar button).
- With "include page" on, it reads the current tab's text and selection and sends them with your question to the local gateway at `/v1/chat/completions`.
  Within a conversation the page text is sent once: later questions about the same, unchanged page send only its title and URL (and any new selection). Switching tabs, the page changing, or a new conversation sends it again.
- The API key is stored in `chrome.storage.local`.
- The service worker strips the `Origin` header on calls to the local gateway (HTTP and WebSocket), because the gateway rejects unknown origins with 403.
- Replies render as GitHub-flavoured Markdown (nested and task lists, tables with alignment, quotes, https images, syntax-highlighted code with a copy button) using vendored marked, DOMPurify and highlight.js (`vendor/`). Raw HTML in replies is shown as text, and output is sanitized.
- With the outrigger plugin's **Outrigger platform** (default), chat goes over the
  outrigger connection through Hermes's messaging pipeline, so Hermes slash
  commands work (`/model`, `/new`, `/help`, `/stop`…) and are sent as typed, without
  the page. Hermes's own progress messages show as muted status lines.
  Hermes's interactive prompts appear as cards: `/model` opens a model picker
  (provider, filter, model), `/reasoning` and similar show choice buttons, the
  `clarify` tool's questions get answer buttons (or checkboxes, plus "Other…"),
  and dangerous-command approvals show the full command with Hermes's own
  approve/deny options.
  Typing `/` opens an autocomplete menu of Hermes's commands (arrow keys, Tab or
  Enter to complete). Images and files Hermes sends (e.g. `/save md`) appear
  inline or as downloads.
- The conversation survives closing the panel: it is kept in memory for this
  browser session (`chrome.storage.session`, cleared when the browser closes),
  along with the redaction map, and replies that arrive while the panel is closed
  are shown when it reopens. "New conversation" clears it. Settings:
  "Chat through the Outrigger platform"; without it (or without the platform) the
  sidebar uses Chat Completions.
- Each conversation has its own Hermes session (`X-Hermes-Session-Id`); Hermes keeps the history, and "New conversation" starts a new session.

## Browser tools (outrigger)

With the [hermes-outrigger](../hermes-outrigger) gateway plugin enabled, the sidebar
attaches to its conversation's session and offers Hermes tools that run in this browser:

| Tool | What it does | Asks you first |
|---|---|---|
| `get_page` | title, URL, selection and visible text of a tab | no |
| `get_selection` | the selected text | no |
| `list_tabs` | tabs in this window | no |
| `snapshot` | outline of links, buttons, fields and headings with refs (`e14`), including shadow DOM | no |
| `scroll` | scroll by a screen, to top/bottom or to an element; reports lazy-loaded content | no |
| `wait_for` | wait for text or an element to appear or disappear | no |
| `fetch_as_user` | GET a URL on the tab's own site with your cookies, as text or JSON | no |
| `click` | click an element by ref or CSS selector | yes* |
| `fill` | set one field by ref or selector | yes* |
| `fill_form` | fill several fields and optionally submit, on one card | yes* |
| `open_url` | open an http(s) URL | yes* |
| `reveal` | give Hermes the real values behind chosen placeholders | yes, always |
| `highlight` | outline an element or highlight text to point something out | no |
| `switch_tab` / `close_tab` | bring a tab to the front / close a tab Hermes opened (in a "Hermes" tab group) | no |
| `screenshot` | capture the visible tab; Hermes looks at it with `vision_analyze` | yes (not redacted) |
| `dev_watch` | console messages, errors and failed requests for N seconds, optionally after a reload | yes |
| `search_history` / `search_bookmarks` | search your history / bookmarks (optional permissions, enable in settings) | yes, always |

Right-click a selection, link, image or page and choose "Ask Hermes about…" to open
the panel with it filled in. A notification tells you when a reply that took over
20 s finishes while you are elsewhere (settings).
| `run_js` | run JavaScript in the page (via `chrome.debugger`) | yes, shows the code |

\* unless Hermes's reviewer approves it, or you allowed that kind of action on the site for this conversation.

Refs come from `snapshot` and are kept in the extension's isolated world, so the
page cannot read or forge them; a ref goes stale when its element is removed.
`fetch_as_user` refuses other sites and redirects to them. See `docs/proposals.md`
for further integration ideas.

Calls show up inside Hermes's reply; approval cards show the exact code or arguments.
While attached, the active tab's title and URL are shared with Hermes as context
for each turn. Turn the whole feature off with "Let Hermes use this browser" in
settings. The header shows whether browser tools are on, connecting or offline.

Gateway setup (once):

```
hermes plugins enable outrigger
hermes tools enable --platform api_server outrigger
systemctl --user restart hermes-gateway
```

### Personal data redaction

On by default (settings: "Hide personal data from Hermes"). Before anything leaves
the browser (your message, attached page text, every tool result, the tab title
and URL), email addresses, phone numbers, card and IBAN numbers, ID numbers, API
keys and tokens, people's names and personal form fields are replaced by
placeholders such as `⟦EMAIL_1⟧`. Detection uses `@arcjet/redact` and
`compromise` (vendored, local, no network) plus a few small detectors.

- Hermes's replies are shown with the real values put back (highlighted).
- Browser actions still work: `fill`, `fill_form`, `open_url` and `fetch_as_user`
  put the real value in on this device, and always ask first, because the value
  then goes to that site.
- If Hermes needs a real value for something outside the browser (an email, a
  file), it calls `reveal`; you tick which values to share on a card.
- "🛡 N redacted" on your message and on tool lines lists what was hidden.
- Per-category switches and a list of sites where nothing is redacted.

Best effort, not a guarantee: unusual formats and names can slip through (name
detection is English and heuristic), and Hermes's own server-side tools see pages
unredacted. `run_js` results are redacted, but code can transform values.

`run_js` attaches Chrome's debugger to the tab for the duration of the call, so
Chrome shows its "started debugging this browser" bar briefly. It cannot run on
`chrome://` pages or the Web Store, or while DevTools is attached to the tab.

## Permissions

It requests `<all_urls>`, `tabs`, `scripting`, `storage`, `debugger` (for `run_js` and `dev_watch`), `contextMenus`, `tabGroups` and `notifications`; `history` and `bookmarks` are optional and only requested when you turn them on. It can read any page you ask about, including logged-in pages. Turn off "include page" to stop attaching page text to your questions, and turn off browser tools in settings to stop Hermes calling tools in the browser.

## License

MIT. See LICENSE.
