# Browser integration proposals

Date: 2026-11-16. Context: Hermes Sidebar with browser tools through the
hermes-outrigger plugin (tools: `get_page`, `get_selection`, `list_tabs`,
`run_js`, `click`, `fill`, `open_url`; confirm cards, per-site grants, LLM
reviewer). Ranked by how much they address problems seen in real use.

Status: all implemented (2026-11-17). 13 phase 2 became the Outrigger platform
(hermes-outrigger docs/platform.md, P1-P4); phase 1's header picker is covered by /model.; 4–11 are proposals.

---

## 1. Page snapshot with element refs — implemented

**Problem.** Hermes acts on pages by guessing CSS selectors or writing `run_js`.
That fails on modern sites (generated class names, shadow DOM, custom elements):
the Reddit "load more replies" attempt went through code, was hard for the
reviewer to judge, and needed approval.

**Proposal.** A read-only `snapshot` tool that lists the page's interactive and
structural elements (role, accessible name, state) with short refs, walking open
shadow roots. Action tools accept `ref` instead of `selector`.

```
Page: "Thread - r/Parkside" https://www.reddit.com/r/... (scroll 0%, 3 screens)
heading "I need more space" [e1] level=1
link "u/Dotternetta" [e2] -> /user/Dotternetta
button "Upvote" [e3]
button "3 more replies" [e14] offscreen
textbox "Add a comment" [e15] value=""
```

- Refs are stable for the same element across snapshots (kept in a WeakMap in
  the extension's isolated world, so the page cannot read or forge them).
- `click`, `fill`, `scroll`, `wait_for`, `fill_form` take `ref` or `selector`.
- Policy `auto` (read-only). Top frame only; closed shadow roots are invisible.

## 2. `scroll` and `wait_for` — implemented

**Problem.** Lazy content (comments, feeds, "load more") only exists after
scrolling or a short delay; Hermes reads too early or falls back to code.

**Proposal.**
- `scroll {to: "top"|"bottom"|"element", ref?, selector?, by?: pixels}` returns
  the new position and whether the page grew (more content loaded). `auto`.
- `wait_for {text?, ref?, selector?, gone?, timeout_ms ≤ 15000}` waits for text or
  an element to appear (or disappear) using a MutationObserver. `auto`.

## 3. Fewer approvals for reads and forms — implemented

**Problem.** Most `run_js` use is reading data with the user's cookies, which needs
a card each time; filling a form is one card per field.

**Proposal.**
- `fetch_as_user {url, max_chars?}`: GET a URL **on the same site as the tab**
  with the user's cookies, from the page, and return text (HTML converted to
  readable text) or JSON. `auto`: it can only read what the user can already see
  on that site. Cross-site URLs and non-GET methods are refused. Residual risk:
  sites that change state on GET; acceptable for a read tool, documented.
- `fill_form {fields: [{ref|selector, value}], submit?: ref|selector}`: one
  confirm card listing every field and value (and the submit target). Class
  "page actions", so grants and reviewer auto-approval apply as for `fill`.

---

## 4. Right-click "Ask Hermes" — implemented

Context-menu entries for selection, link and image: open the panel with the item
attached as context. Uses `contextMenus`; no gateway changes. Low risk.

## 5. Conversations that survive closing the panel — implemented

Store `{sessionId, page state}` per window in `chrome.storage.session`; on open,
reload the transcript from `GET /api/sessions/{id}/messages` and render it. Today
closing the panel loses the visible conversation although Hermes keeps it.

## 6. `highlight` — implemented

Outline and scroll to an element (ref/selector) or text passage for a few
seconds, so Hermes can point instead of describe. `auto`; purely visual.

## 7. Tab management — implemented

`switch_tab {tab}`, `close_tab {tab}` (only tabs Hermes opened), and put tabs
Hermes opens into a "Hermes" tab group (`tabGroups` permission) so they are easy
to find and close.

## 8. Notify when a long turn finishes — implemented

`chrome.notifications` when a reply completes while the panel is hidden or
another tab is active. Optional in settings.

## 9. `screenshot` — implemented

Capture the visible tab (`captureVisibleTab`) for charts, images and layout.
As built: a plugin tool's result is text to the model (encoding the image as
base64 or digits would only make a huge, meaningless string), so the sidebar
returns `image: {mime, data}` and the plugin saves it under
`plugin-data/outrigger/captures/` (png/jpeg/webp, 8 MB, newest 20) and returns
`image_path`. Hermes opens it with its own `vision_analyze`, which shows it
natively on vision-capable models and otherwise uses the auxiliary vision model.
Confirm class "screenshots" (not redacted, so not reviewer-approved).

## 10. Developer tools — implemented

`console_logs` and `failed_requests` through `chrome.debugger` (Runtime/Log and
Network domains), for debugging the user's own web apps. Confirm class "code".

## 11. Bookmarks and history search — implemented

`search_history {query}`, `search_bookmarks {query}` for recall ("that article
last week"). Personal data across sites: always confirm, never auto-approved.

## 12. PII redaction before anything leaves the browser, with `reveal` — implemented

Implementation notes (differences from the plan below):
- Arcjet matches token by token, so `(jane@x.com,` was missed. It is given a copy of
  the text with brackets and punctuation blanked to spaces (same length); matched
  strings are then replaced in the original. National phone formats Arcjet misses
  (UK `0xxxx`, US `(xxx) xxx-xxxx`) have a small extra detector.
- Putting a redacted value into a page or URL (`fill`, `fill_form`, `open_url`,
  `fetch_as_user`) discloses it to that site, so such a call always shows a card
  naming the values, whatever the reviewer says or what was granted. Otherwise a
  reviewer-approved `open_url` could carry a value anywhere without `reveal`.
- `run_js` code is never given real values.
- Context budget: the plugin's `context_max_chars` default is now 4,500 so the 13
  tools and the placeholder note fit in full.

**Problem.** Everything the sidebar sends goes to Hermes and on to the model
provider: attached page text, tool results (`get_page`, `snapshot`,
`fetch_as_user`, `run_js`), the tab title and URL in `context.update`, and the
user's own messages. Logged-in pages are full of personal data (email
addresses, phone numbers, names, addresses, account and card numbers, tokens in
URLs), most of it irrelevant to the question, and it ends up in the session
history, Hermes's memory, logs and the provider's retention.

**Proposal.** Redact personal data in the sidebar with established local
libraries, replacing each value with a placeholder. Values go back in locally
when Hermes acts in the browser, and Hermes can ask for specific real values
with a `reveal` tool when it needs them elsewhere (for example to send an email
with its own email tool). Each reveal is approved on a card.

### Where it runs

One choke point: every outbound string passes through the redactor in `send()`
(message and page context), `Outrigger._runCall` (each tool result, before
`result`) and `setContext` (title and URL). Nothing else talks to the gateway.

### Placeholders

Each distinct value becomes a typed placeholder that is stable for the
conversation: `⟦EMAIL_1⟧`, `⟦PHONE_2⟧`, `⟦NAME_1⟧`, `⟦CARD_1⟧`. The map
(placeholder ↔ value) lives only in panel memory and is cleared by a new
conversation.

- **Browser actions keep working without revealing anything.** When Hermes calls
  `fill`, `fill_form`, `open_url` or `fetch_as_user` with a placeholder, the
  sidebar substitutes the real value just before running the call. Approval
  cards show the real value, marked as redacted.
- **The user reads real values.** Hermes's replies are rendered with
  placeholders swapped back, shown with a subtle highlight.
- **Unknown placeholders are left alone.** A placeholder Hermes invents that is
  not in the map is never guessed.

### Detection libraries (all run locally, vendored)

| Library | Version | Licence | Size | Detects | Notes |
|---|---|---|---|---|---|
| [`@arcjet/redact`](https://github.com/arcjet/arcjet-js/tree/main/redact) + `@arcjet/redact-wasm` | 1.15.0 (2026-10-28) | Apache-2.0 | ~180 KB Wasm | email, phone, card number, IP address | The engine. Its `replace(entity, plaintext)` callback lets us issue our own placeholders; its `detect(tokens)` hook takes custom detectors. The Wasm is embedded as a `data:` URL, so there are no network calls. The manifest needs `'wasm-unsafe-eval'` in `content_security_policy.extension_pages`. |
| [`compromise`](https://github.com/spencermountain/compromise) | 14.19.0 (2026-10-18) | MIT | ~340 KB | people's names, places (English) | Rule-based NLP: `nlp(text).people()`, `.places()`. No eval, no network. Run first; matches are fed to Arcjet's `detect` hook as custom entities. |
| Custom detectors (our code, via Arcjet `detect`) | — | — | small | IBAN (mod-97), API keys and tokens (`sk-`, `ghp_`, `xox*`, JWTs, high-entropy `token=`/`key=`/`sig=` query values), UK NI and US SSN with a nearby context word | Only what the libraries lack. |
| Form-field semantics (from `snapshot`) | — | — | — | values of fields with `autocomplete` email/tel/name/street-address/postal-code/cc-*/bday, or type email/tel | Catches names and addresses in forms that text patterns miss. |

Considered and rejected:
- `redact-pii` depends on Google Cloud DLP, so it is server-side.
- `openredaction` is a meta-package pulling in Express, server and React code.
- `@redactpii/node` has fewer rules and ships a dashboard client.
- Microsoft Presidio is Python. It could run in the plugin, but by then the
  data has already left the browser.

**Phase 2 (optional):** a multilingual on-device NER/PII model through
`@huggingface/transformers` (WebGPU/Wasm), for names and addresses in
non-English text. Large download (~100 MB+), so behind a setting.

### `reveal`: Hermes asks for specific values

```json
{ "name": "reveal", "policy": "confirm",
  "description": "Get the real values behind ⟦…⟧ placeholders when a task outside this browser needs them (e.g. sending an email). Not needed for click/fill/fill_form/open_url/fetch_as_user, which substitute placeholders themselves.",
  "parameters": { "type": "object", "required": ["placeholders", "purpose"], "properties": {
    "placeholders": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 20 },
    "purpose": { "type": "string", "description": "What the values are for, shown to the user" } } } }
```

The card:

```
Hermes asks for 2 redacted values
Purpose: "Reply to the customer by email"
  [x] ⟦NAME_1⟧   Jane Doe
  [x] ⟦EMAIL_1⟧  jane@example.com
[Reveal selected]  [Deny]
```

- The user can untick items; only ticked values are returned:
  `{"⟦NAME_1⟧": "Jane Doe", "⟦EMAIL_1⟧": "jane@example.com"}`. Unticked or
  unknown placeholders are listed as withheld.
- It has its own approval class, **"revealing data"**. The reviewer never
  auto-approves it, and there is no per-site grant, because what it releases
  doesn't depend on a site. Optionally, "always reveal ⟦EMAIL_1⟧ in this
  conversation" for a value the user is happy to share.
- A revealed value stays mapped to its placeholder (redaction stays
  consistent), and the card says it has now been shared with Hermes.
- The audit log records the placeholders and purpose, never the values.

### Plugin side

No protocol change is needed. The client reports `redaction: {enabled,
categories}` in `hello`; the context block then tells the model that `⟦…⟧`
placeholders stand for real values, that browser tools accept them as-is, and
that `reveal` exists for anything else.

### Controls

- Settings: on/off, per-category toggles, and a per-site "don't redact here"
  list for sites where the data is the point (e.g. the user's own CRM).
- Each sent message and tool line shows "🛡 3 redacted"; clicking it lists what
  was replaced (locally only).
- The user's own typed message is redacted too. The model can still use their
  email to fill a form through the placeholder, or ask with `reveal`.

### Limits (to state in the README)

- **Best effort, not a guarantee.** Missed formats and names leak, and
  over-matching can break a task (an order number that looks like a phone
  number). Library validation (Luhn, mod-97) and context words keep false
  positives down; `reveal` and the per-site list are the escape hatches.
- **Name detection is English-only and heuristic** until phase 2.
- **Covers only what the sidebar sends.** Hermes's own tools (web search, its
  own browser, terminal) fetch pages server-side, unredacted.
- **`run_js` can evade patterns.** It can compute or transform values (e.g.
  base64); its results are redacted like any other, but the code itself is not.
- **Images and screenshots** (proposal 9) need separate handling.

### Testing

- A corpus of positive and negative samples per category, including look-alikes:
  dates, order numbers, version strings, hashes.
- Round trip: redact → Hermes fills with a placeholder → the page gets the real
  value.
- `reveal`: only ticked values are returned; deny returns nothing; nothing is
  returned without a card.
- No placeholder map or unrevealed value ever leaves the panel (assert on every
  outbound frame).

## 13. Model picker and slash commands

**Problem.** Users expect the commands they use elsewhere in Hermes, `/model`
above all. Today the sidebar sends `/model` as an ordinary message.

**What the gateway does today** (checked on v0.23.1, 2026-11-16):
- **No slash-command dispatch on Chat Completions.** `/model` and `/help` sent as
  chat messages were answered by the model as prompts, about 18k tokens each.
  `/model` happened to name the right model; `/help` invented a command list.
- **Per-request model choice is supported.** `model` + `provider` on
  `POST /v1/chat/completions` is honoured whenever `provider` is sent. A bare
  `model` is ignored unless `gateway.platforms.api_server.direct_model_requests`
  is set. `model_options` carries reasoning effort and service tier.
- **The picker data is available.** `GET /api/model/options` (same bearer key)
  returns `{model, provider, providers: [{slug, name, models, is_current,
  authenticated, free_tier, plan_usage, unavailable_models, …}]}`: 52 providers
  on this install. `?refresh=1` re-probes custom endpoints.
- **Real slash commands live on the gateway JSON-RPC protocol.** `/api/ws`
  (`hermes-gateway-v1`) has `commands.catalog`, `command.resolve`,
  `command.dispatch` and `slash.exec`. It needs a single-use ticket minted over the
  user's private local control socket (`hermes gateway attach --json`), which a
  browser extension cannot reach on its own.
- **A plugin cannot run Hermes's own commands.** There is no public plugin API for
  it (`ctx.register_command` only adds new ones), so the outrigger plugin cannot
  relay them.

### Phase 1: model picker and sidebar commands (no gateway changes)

**Model picker.** A compact control in the header shows the model in use
(`hy4-flash · nous`). Clicking it opens a searchable list from
`/api/model/options`:
- grouped by provider, authenticated providers first;
- free-tier and plan-usage hints, unavailable models greyed out.

Choosing a model:
- sets `{model, provider}` for the **current conversation** and sends it on every
  request (always with `provider`, so it is honoured);
- "Make default" saves it in settings for new conversations;
- "Hermes default" clears the override.

An optional reasoning-effort control (low / medium / high) maps to
`model_options.reasoning_effort` for models that advertise it. The list is cached
for the panel's lifetime; a refresh button calls `?refresh=1`.

**Sidebar commands.** Typing `/` at the start of the composer opens an autocomplete
menu. The commands run in the sidebar and never reach the model:

| Command | Does |
|---|---|
| `/model [name]` | open the picker, or switch directly when `name` matches one model (`/model sonnet`, `/model nous:hy4-flash`) |
| `/effort low\|medium\|high\|default` | reasoning effort for this conversation |
| `/new` | new conversation (same as +) |
| `/page on\|off` | attach page text or not |
| `/tools on\|off` | browser tools for this panel |
| `/redact on\|off` | personal-data redaction (with a confirmation when turning it off) |
| `/status` | model, session id, tools state, redaction, grants in effect |
| `/help` | list these commands |

An unknown `/word` is **not** sent to the model. The sidebar says Hermes commands
are not available in the sidebar yet, with "Send as a message" for a message that
merely starts with a slash. This avoids the wasted turn and invented answers seen
in the check above.

Precedence caveat: a session-level `/model` override set elsewhere wins over
per-request fields. API sessions created by the sidebar have none, so the picker
is authoritative there.

### Phase 2: real Hermes commands through the Outrigger platform

Discord gets slash commands, the `/model` picker and approval buttons because it
is a Hermes **platform adapter**: its messages go through the gateway's pipeline
(authorization, session, slash-command dispatch) before the agent. The sidebar
should become one too. Not as a sidebar-specific adapter, but through a
client-neutral **Outrigger platform** in the outrigger plugin, which any outrigger
client can use. Design: `hermes-outrigger/docs/platform.md`.

For the sidebar this means:
- **Chat moves to the outrigger WebSocket** (`chat.send` / `chat.message` /
  `chat.edit`) instead of Chat Completions.
- **All Hermes slash commands work**, including a server-side `/model` that sticks
  to the session.
- **Hermes's own prompts appear as cards:** the model picker, choice pickers,
  clarify questions, command approvals and slash confirmations.
- **No extra pieces:** no native helper, works with a remote gateway, and only
  documented plugin APIs.

The phase-1 header picker can stay as a shortcut that sends
`/model <provider:model>`.

Rejected alternative: talking to the gateway JSON-RPC protocol (`/api/ws`)
through a Chrome native-messaging host that runs `hermes gateway attach --json`
for single-use tickets. It needs a native install and a local gateway, and
sidebar chats would be TUI sessions rather than a platform of their own.

### Upstream alternative

An authenticated HTTP command endpoint on the API server (`GET /api/commands`,
`POST /api/sessions/{id}/commands`) would give Chat Completions clients real
commands too. It is worth requesting, but the Outrigger platform does not depend
on it.

### Testing

- Picker: lists match `/api/model/options`. A chosen model is sent with
  `provider`, the reply comes from it (checked via usage/attribution), and the
  choice persists per conversation and resets on `/new`.
- Commands: none of the sidebar commands sends a chat request (assert on
  outbound requests). An unknown command makes no request until the user picks
  "Send as a message".
- Phase 2: see the testing section of `hermes-outrigger/docs/platform.md`.

## 14. Notebook mode: edit notes on the Hermes host, with `//` commands — N1-N2 implemented

Open a Markdown note that lives on the Hermes machine (for example the
`~/vaults/notes` Obsidian vault) in a Note view, edit it with autosave back to
the file, and type a line starting with `//` (`//correct my spelling`,
`//flesh this out`, `//find some relevant links`) to have Hermes do it.

The flow: Hermes removes the line, the editor pauses while Hermes works on the
paragraph or section above, the changes land live, and the editor unlocks with a
summary, a diff highlight and Undo.

The file handling, versions and conflict handling with Obsidian, locks, and the
Hermes side (the note's own chat on the Outrigger platform, and the scoped
`notebook_read` / `notebook_edit` tools) live in the outrigger plugin. Full
design: `hermes-outrigger/docs/notebook.md` (milestones N1-N4).
