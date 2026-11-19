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
- **Not run:** no live browser load, no dynamic/exploit testing. Headless Firefox in the
  review sandbox would not open its remote-debugging port, so runtime behaviour is
  **NOT VERIFIED**. `web-ext lint` (0 errors) and `node --check` were run; these prove
  manifest/API and syntax validity, **not** runtime correctness.

## Verdict

The extension's security design is strong: model output is sanitized before it reaches
the DOM, browser tools are approval-gated with a deliberate PII-disclosure carve-out,
page element refs are kept out of the page's reach, and same-site fetch is origin- and
redirect-checked. **One concrete bug was found and fixed** (a Firefox CSP regression that
silently disabled part of the PII redactor). The remaining items are design/functional
trade-offs left for the maintainer, plus runtime behaviours that need a live load.

## Findings

| ID | Severity | Area | Status |
|----|----------|------|--------|
| F1 | High (privacy) | Firefox CSP blocks WASM → PII redaction silently fails | **Fixed** (`90590db`) |
| D1 | Medium (design) | API key in WS subprotocol; plaintext over remote `ws://` | Discuss |
| D2 | Low | Outrigger hello hardcodes Chromium identity on Firefox | Discuss |
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
- **Residual:** runtime confirmation that WASM compiles and arcjet detects under the new
  CSP still requires a live Firefox load (see Verification gaps).

### D1 — API key travels in the WebSocket subprotocol (design)

- **Where:** `shared/outrigger.js:72` (`new WebSocket(url, ['hermes-outrigger.v1', 'bearer.' + key])`),
  `shared/options.js:82` (test connection), `options.js:97–100` (remote warning).
- **What:** browsers cannot set headers on a WebSocket, so the key is sent as the
  `bearer.<key>` subprotocol. On the default local gateway (`http://127.0.0.1:8642`) this is
  loopback. For a **remote** endpoint over `http:`/`ws:` (no TLS) the key is observable on
  the wire. The UI already advises a paired `otr_…` token for remote use, and the API key is
  documented as local-only.
- **Why not changed:** inherent browser limitation; mitigations exist. Options to discuss:
  refuse/warn on non-`wss` remote endpoints, or require a paired token for any non-loopback
  host. This is a functional/policy change, left to the maintainer.

### D2 — Outrigger hello misidentifies Firefox (low)

- **Where:** `shared/outrigger.js:78–79` — `kind: 'chromium-extension'`, default
  `label = 'Chromium side panel'` (`outrigger.js:18`).
- **What:** on Firefox the client still reports a Chromium identity to the gateway. Cosmetic
  for chat, but the gateway could branch on `kind`. Suggested fix: derive `kind`/`label` from
  `Platform.name`. Left unchanged because it is server-visible behaviour (functional).

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

## Verification gaps (NOT RUN)

These need a live load (`about:debugging` → Load Temporary Add-on → `dist/firefox/manifest.json`,
and `dist/chrome` unpacked) before claiming runtime success:

1. **F1 fix:** arcjet WASM compiles under the new Firefox CSP and email/phone/card/IP are
   actually redacted (watch for `redactor: arcjet failed` in the console).
2. **page-agent persistence:** `globalThis.__hermes` survives across separate
   `tabs.executeScript` injections in Firefox (the `agent()` ref mechanism depends on it).
3. **Async bridge:** `executeInPage`/`runJs` round-trip via `runtime.sendMessage` resolves
   correctly, including object/DOM serialization.
4. **Origin-strip on WebSocket:** the blocking `webRequest` rule strips `Origin` on the
   outrigger WS handshake (Firefox `originUrl`/`documentUrl` for WS), so the gateway accepts it.
5. **Chrome regression check:** the refactor to `Platform.*` preserves side-panel open,
   CDP `run_js`/`dev_watch`, tab grouping and DNR Origin-strip.

## Recommendations

- Land F1 (done). Re-run the live checks above on both browsers.
- Decide D1 (remote `wss`/token policy) and D2 (platform identity) — both small, server-visible.
- Keep the README's Firefox limitations (D3/D4) in sync with any adapter changes.
- Consider a tiny self-test that asserts arcjet detected a known email/phone after load, so a
  future CSP/WASM regression fails loudly instead of silently (the current `catch` hides it).
