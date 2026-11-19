# Security review — Hermes Sidebar (Firefox port)

- **Date:** 2026-11-19
- **Scope:** `firefox-port` branch at commit `90590db` (port `08fd2bf` + CSP fix `90590db`).
  Reviewed the security-critical shared code and both browser adapters/manifests:
  `redactor.js`, `markdown.js`, `outrigger.js`, `browser-tools.js`, `page-agent.js`,
  `panel.js` (tool gating, rendering, media, key use), `options.js`, `notebook.js`,
  `prompts.js`, `background-common.js`, `chrome/platform.js`, `firefox/platform.js`,
  `chrome/manifest.json`, `firefox/manifest.json`. Vendored libraries treated as
  third-party (versions recorded in `credits.js`).
- **Method:** static source review (read-only). Trace source → control → sink across
  trust boundaries: page ↔ extension, extension ↔ Hermes gateway, model output ↔ DOM.
- **Runtime verification:** initially not run (headless Firefox in the review sandbox
  would not open its remote-debugging port). On 2026-11-19 the port was load-tested in
  headless Firefox 158.0.1 via geckodriver (temporary add-on, checks executed in the real
  extension context): gaps 1–4 below are now **VERIFIED**, and the load test found and
  fixed a second port bug (F2). The Chrome regression pass (gap 5) ran the same day on
  Chromium 159 (Playwright build, extension loaded unpacked): all five gaps are now
  **VERIFIED**. `web-ext lint` (0 errors) and `node --check` pass on both builds.

## Verdict

The extension's security design is strong: model output is sanitized before it reaches
the DOM, browser tools are approval-gated with a deliberate PII-disclosure carve-out,
page element refs are kept out of the page's reach, and same-site fetch is origin- and
redirect-checked. **Two concrete bugs were found and fixed**: F1, a Firefox CSP
regression that silently disabled part of the PII redactor (static review), and F2,
Firefox's callback-only `chrome.*` breaking every promise-style API call in the shared
code (runtime load test). D1 and D2 are decided and fixed; the remaining items are the
documented D3/D4 capability limits.

## Findings

| ID | Severity | Area | Status |
|----|----------|------|--------|
| F1 | High (privacy) | Firefox CSP blocks WASM → PII redaction silently fails | **Fixed** (`90590db`) |
| F2 | High (functional) | Firefox `chrome.*` is callback-only; shared code awaits promises | **Fixed** (`api-shim.js`) |
| D1 | Medium (design) | API key in WS subprotocol; plaintext over remote `ws://` | **Decided (c) + fixed**: token required off-loopback |
| D2 | Low | Outrigger hello hardcodes Chromium identity on Firefox | **Fixed**: identity follows the browser |
| D3 | Low | Firefox `run_js` accepts expressions/IIFEs only | Discuss |
| D4 | Low | Firefox `dev_watch` capture limits (CSP/spoof/reload) | Documented |

### F1 — Firefox CSP blocked WASM, silently disabling PII redaction (FIXED)

- **Where:** `firefox/manifest.json` `content_security_policy`; `shared/redactor.js:159–165`;
  `shared/vendor/arcjet-redact.js` (`WebAssembly.compile` / `WebAssembly.instantiate`).
- **What:** `@arcjet/redact` ships with `@arcjet/redact-wasm` (see `credits.js`) and compiles
  embedded WASM at runtime to detect email, phone, card and IP. The Chrome MV3 CSP allows
  this with `script-src 'self' 'wasm-unsafe-eval'`. The initial Firefox MV2 CSP was
  `script-src 'self'; object-src 'self'` (no `wasm-unsafe-eval`), so the WASM compile is
  blocked. The redactor wraps arcjet in `try/catch` and only `console.warn`s on failure
  (`redactor.js:165`), so detection of **email / phone / card / IP silently stops** on
  Firefox while the other detectors (secrets, IBAN, IDs, names, fields) keep working.
  Net effect: those PII categories would be sent to Hermes unredacted — a privacy
  regression introduced by the port, with no visible error.
- **Fix:** Firefox CSP now `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`,
  matching Chrome. `web-ext lint` accepts it (0 errors).
- **Residual:** none — runtime-verified on 2026-11-19 (see Runtime verification, check 1).

### F2 — Firefox `chrome.*` is callback-only; shared code awaits promises (FIXED)

- **Where:** every shared caller of `chrome.*` — `panel.js`, `options.js`, `notebook.js`,
  `notebook-page.js`, `browser-tools.js`, `background-common.js` — plus `firefox/platform.js`
  (`bridge`, `waitForLoadFF`, `devWatch`, `injectFile`).
- **What:** the shared code was written for Chrome MV3, where `chrome.*` returns a promise
  when no callback is passed. Firefox's `chrome.*` is callback-only and returns `undefined`.
  Found by the runtime load test: the async bridge and `dev_watch` threw at `.catch` on
  `undefined`, and `await chrome.storage.local.get(...)` destructured `undefined` — panel
  init, options, notebook, browser tools and the background's Origin-sync would all fail
  on Firefox. `web-ext lint` cannot see this: the APIs exist, only the calling convention
  differs.
- **Fix:** `shared/api-shim.js`, loaded before all other scripts in every context
  (`background.scripts` in the Firefox manifest; first script tag in `panel.html`,
  `options.html`, `notebook.html`). Where the promise-based `browser.*` namespace exists
  (Firefox), `chrome` becomes a thin Proxy adapter over it: async methods return promises,
  callback-style calls still work (`contextMenus.removeAll(cb)`), events and synchronous
  members (`runtime.getURL`, `getManifest`) pass through untouched. No-op on Chrome.
- **Verified:** `chrome.tabs.executeScript` / `chrome.storage.local.get` return resolving
  promises and callback style still fires; the bridge, `dev_watch`, storage-driven panel
  init and the background Origin rule all pass the runtime checks below.

### D1 — API key travels in the WebSocket subprotocol (DECIDED + FIXED)

- **Where:** `shared/outrigger.js` (`_connect`, `isLoopbackEndpoint`),
  `shared/options.js` (`testWS`), `shared/options.html` (key help text).
- **What:** browsers cannot set headers on a WebSocket, so the key is sent as the
  `bearer.<key>` subprotocol. On the default local gateway (`http://127.0.0.1:8642`) this is
  loopback. For a **remote** endpoint over `http:`/`ws:` (no TLS) the key is observable on
  the wire.
- **Decision (Autumn, 2026-11-19): option c** — the API key is the owner credential and is
  accepted only for loopback endpoints (`127.0.0.1`, `localhost`, `::1`). Any non-loopback
  gateway requires a paired `otr_…` token (scoped, revocable). Enforced in BOTH the live
  connection (`Outrigger._connect` refuses before creating a socket, reports a clear
  offline status, and does not retry — a settings change calls `start()` again) and the
  settings test-connection (`testWS`). README and options help text state the policy.
- **Pinned by:** `tests/outrigger-policy.test.mjs` (remote+key refused, remote+token
  allowed, loopback variants allowed, recovery after settings change, testWS parity).

### D2 — Outrigger hello misidentifies Firefox (FIXED)

- **Where:** `shared/outrigger.js` — `PLATFORM_NAME` / `CLIENT_KIND` / `CLIENT_LABEL`.
- **What:** the hello used to hardcode `kind: 'chromium-extension'` and the default label
  'Chromium side panel' on every browser. Now the identity derives from `Platform.name`
  where the adapter is loaded, and from the `browser.*` namespace otherwise (the notebook
  page loads `outrigger.js` without the platform adapter): Firefox reports
  `firefox-extension` / 'Firefox sidebar'; Chrome is unchanged. Explicit labels (the
  notebook's 'Hermes notes tab') are preserved.
- **Pinned by:** `tests/outrigger-policy.test.mjs` (both adapters, the notebook fallback,
  and the no-signal Chromium default).

### D3 — Firefox `run_js` capability gap (low)

- **Where:** `firefox/platform.js` `runJs` wraps the supplied code as `(<code>)` and awaits it;
  `chrome/platform.js` `runJs` uses CDP `Runtime.evaluate`.
- **What:** the tool contract is "an expression or IIFE", which both honour. Chrome's CDP also
  tolerates statement bodies; the Firefox wrapper does not. Minor capability difference, not a
  vulnerability (`run_js` is approval-gated and its args are never unredacted). Document for
  parity expectations.

### D4 — Firefox `dev_watch` capture limits (low, documented)

- **Where:** `firefox/platform.js` `DEV_HOOK_MAIN` / `DEV_HOOK_INJECT` / `DEV_READ_BODY`, `devWatch`.
- **What:** with no CDP, console/errors are captured by a **main-world** hook injected via a
  `<script>` element, and failed requests via `webRequest`. Consequences: (a) pages with a
  strict `script-src` CSP block the inline hook → console capture may be empty (network capture
  still works); (b) the read-back uses `window.postMessage`, so a hostile page can spoof the
  returned console buffer (integrity of a debugging aid only — the page already controls its own
  console); (c) capture starts after any reload. These are inherent to the no-CDP approach and
  are documented in the README. No cross-origin or privilege boundary is crossed.

## Security strengths observed (evidence)

- **Reply sanitization (`markdown.js`):** marked GFM + DOMPurify; raw HTML is escaped
  (`markdown.js:23`); `afterSanitizeAttributes` restricts links to `https?:`/`mailto:` and adds
  `target=_blank rel=noopener noreferrer` (`:27–32`), removes non-`https` images and sets
  `referrerpolicy=no-referrer` (`:33–37`), allows only disabled checkbox inputs (`:38–42`);
  `FORBID_TAGS` includes `style/form/iframe/svg/math/video/audio` and `FORBID_ATTR: ['style']`
  (`:45–48`). All `innerHTML` sinks in `panel.js`/`notebook.js`/`prompts.js` are static strings,
  `=''` clears, or `renderMarkdown(...)` output. No `eval`/`new Function` in shared code.
- **Tool approval gating (`panel.js:348–402`):** `run_js` args are **not** unredacted
  (`:356`); PII-disclosing tools (`DISCLOSING_TOOLS`, `:346`) always prompt with no grant or
  reviewer bypass (`:367–371`); other confirm-tools require an Allow card unless a per-site
  grant or reviewer-approve applies, and reviewer auto-approve is limited to `act`/`navigate`
  classes (`browser-tools.js` `REVIEWER_CLASSES`); results are redacted before leaving (`:393`);
  `reveal` is per-value approved (`revealCard`).
- **In-page agent (`page-agent.js`):** element refs held in `WeakRef`/`WeakMap` in the isolated
  world (`:8–16`) — the page cannot read/list/forge them; `fetchAsUser` enforces
  `u.origin === location.origin` **and** re-checks the final `r.url` origin after redirects
  (`:296–300`); password field values are masked in snapshots (`:130`).
- **Redactor (`redactor.js`):** fail-closed `activeFor` on invalid/empty URL (`:107–112`);
  name/place matching builds regexes via `escRe` (no regex injection, `:186`); the value map
  (`byPh`) is never sent — only placeholders leave the browser.
- **Messaging surface:** no `externally_connectable` in either manifest, so web pages cannot
  `runtime.sendMessage` the extension; the Firefox async bridge (`firefox/platform.js`) only
  accepts messages from its own injected code filtered by a per-call id. Conversation memory
  and the redaction map live in `chrome.storage.session` (cleared on browser close).
- **Media (`panel.js:650–670`):** inline data becomes a `blob:` object URL; remote media must
  match `^https?://`; images set `referrerPolicy='no-referrer'`; file links use
  `rel=noopener noreferrer`.

## Runtime verification (2026-11-19)

**Method:** headless Firefox 158.0.1 (snap) launched with `-marionette
-remote-allow-system-access`, driven via `geckodriver --connect-existing`; `dist/firefox`
installed as a temporary add-on (base64 XPI over WebDriver); `panel.html` opened as a tab
with the system principal so checks run in the real extension context; a local test page
on `127.0.0.1:8765`; WS checks against a standalone aiohttp gateway mounting the **real**
outrigger `ws_handler` with an Origin-rejecting middleware and a test `auth_token`
(`127.0.0.1:8643`). Harness scripts, results JSON and screenshots were kept in the
session scratch dir `sidebar-validate`. The Chrome pass used playwright-core driving the
full Chromium 159 build with `dist/chrome` loaded unpacked (`--load-extension`,
`--silent-debugger-extension-api`); checks ran in the service worker and the panel page
opened as a tab (`chrome-extension://<id>/panel.html`).

| # | Check | Result |
|---|-------|--------|
| 1 | F1: arcjet WASM under the new Firefox CSP | **PASS** — email/phone/card/IP all redacted (`⟦EMAIL_1⟧ … ⟦IP_1⟧`), zero `redactor: arcjet failed` warnings |
| 2 | page-agent persistence across `executeScript` injections | **PASS** — `__hermes` marker survives separate injections; element ref `e4` resolved and clicked in a later injection; `fill` works; password values masked in snapshots; email field tagged `⟪pii:email:…⟫` |
| 3 | Async bridge (`executeInPage` / `runJs`) | **PASS** — args/objects round-trip via `runtime.sendMessage`; DOM serialized (h1 `outerHTML`, input array) |
| 4 | Origin-strip on the gateway WebSocket | **PASS** — extension WS opens, selects `hermes-outrigger.v1`, hello → welcome against the real plugin with Origin rejection active; a MAIN-world page WS with the same key is refused (1006). HTTP contrast: extension fetch 404 (Origin accepted) vs request with page Origin 403 |
| 5 | Chrome regression (side panel, CDP tools, tab groups, DNR) | **PASS** — Chromium 159: `sidePanel.getPanelBehavior` shows `openPanelOnActionClick: true` and `sidePanel.open` succeeds; CDP `run_js` (object + async IIFE + DOM serialization) and `dev_watch` (console ticks + 404s) work; the tab lands in the orange 'Hermes' group; the DNR rule strips Origin (an extension GET reaches the plugin handler — 401 without a key, not the 403 an Origin would draw) and follows the endpoint setting; extension WS hello → welcome, main-world page WS refused (1006) |

The shared security checks were re-run on Chrome as well: redaction/WASM, page-agent
persistence, element refs, fill and password masking all pass, with zero page errors.

Also verified: the panel UI renders end-to-end (storage-driven init, tab status line,
restricted-page detection, key warning); `chrome.*` promise **and** callback styles both
work through the shim (F2); `web-ext lint` 0 errors; `node --check` on both builds.

**Limits of this verification:** on Firefox the panel was driven as a tab — the
`sidebar_action` open/close UX itself is untested (Chrome's `sidePanel.open` was verified
programmatically). No exploit-style dynamic testing was done. The WS attach was validated
against the plugin's handler in a test gateway, not the production Hermes gateway (whose
outrigger plugin is not enabled on the validation host).

## Recommendations

- F1 and F2 are landed; all five runtime checks pass on both browsers (Firefox 158,
  Chromium 159).
- D1 (option c) and D2 are decided and implemented, pinned by `tests/outrigger-policy.test.mjs`
  (`node --test tests/outrigger-policy.test.mjs`).
- Keep the README's Firefox limitations (D3/D4) in sync with any adapter changes.
- Consider a tiny self-test that asserts arcjet detected a known email/phone after load, so a
  future CSP/WASM regression fails loudly instead of silently (the current `catch` hides it).

## Addendum (2026-11-19): finding N1 — D1 enforcement gap on the chat path

Found during the AUDIT.md readability rewrite (claims pass). Earlier records above are
left as written.

- **Where:** `shared/panel.js` `send()`, the Chat Completions fallback (`fetch` to
  `/v1/chat/completions` with `Authorization: Bearer <key>`).
- **What:** D1 (option c) was implemented in the outrigger connection (`_connect`) and the
  settings test-connection (`testWS`), as recorded above. The plain chat path was not
  covered. With a remote endpoint and the API key, `_connect` refuses, so the panel is not
  attached, `usePlatform()` is false, and `send()` falls through to the fetch, which
  sends the API key to the remote endpoint (in cleartext on `http:`). The options help text
  ("the API key never leaves the Hermes machine") overstates the behaviour for the same
  reason.
- **Severity:** Medium. It defeats the decided D1 rule in a reachable configuration
  (remote endpoint plus API key, which the settings page lets you save).
- **Status:** **Open.** Not fixed in the documentation change, per AGENTS.md
  (refactor/docs ≠ remediation). Suggested fix: apply `isLoopbackEndpoint` in `send()`
  before the fetch (refuse with the same message as `_connect`), correct the options help
  text, and extend `tests/outrigger-policy.test.mjs` to cover the chat path.
- **Interim guidance:** use a paired `otr_` token for any remote gateway. The README and
  AUDIT.md now state the gap.
