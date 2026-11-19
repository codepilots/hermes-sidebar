# Browser integration proposals

Date: 2026-11-16. Context: Hermes Sidebar with browser tools through the
hermes-outrigger plugin (tools: `get_page`, `get_selection`, `list_tabs`,
`run_js`, `click`, `fill`, `open_url`; confirm cards, per-site grants, LLM
reviewer). Ranked by how much they address problems seen in real use.

Status: 1-14 implemented (2026-11-17). 13 phase 2 became the Outrigger platform
(hermes-outrigger docs/platform.md, P1-P4); phase 1's header picker is covered by /model. 15 (scheduled browser scripts) and 16 (the agent's name) are proposed; round 3 (17-26) at the end.

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

## 14. Notebook mode: edit notes on the Hermes host, with `//` commands — implemented (N1-N4)

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

## 15. Scheduled browser scripts ("browser cron")

Date: 2026-11-17. Status: proposed.

Hermes sets a small script running in your browser on a schedule. The script
does the cheap, repetitive part: load a page, read a price, check a
dashboard, look for a reply. It wakes Hermes only when there's something to
act on. Examples:

- "Check this product page every hour; tell me if it drops below £50."
- "Every weekday at 9:00, read my team's status board and summarise what
  changed."
- "Watch this PR page every 10 minutes and ping me when CI goes green."

### Why in the browser, not Hermes's own cron

Hermes's `cronjob` tool runs on the gateway. To use the browser it would need
a sidebar attached and bound to the cron session, which never is. It would
also run a full model turn every time, even when nothing changed. A browser
schedule:

- runs with your logins;
- costs nothing while the answer is "no change";
- wakes Hermes only on a real event.

### Tools (sidebar)

**`schedule_script`** (confirm class "schedules", never auto-approved).

Arguments:

| Argument | Meaning |
|---|---|
| `name` | short label, e.g. `price-watch` |
| `script` | page JavaScript, the same as `run_js`: a body that may `await` and `return`s a JSON value |
| `target` | `{url}` to open in a background tab for the run, or `{match}` (a URL pattern) to use an open tab |
| `schedule` | `{every_minutes}` (at least 5 by default), `{cron: "0 9 * * 1-5"}` (5 fields, local time), or `{at}` (one-off ISO time) |
| `wake` | `on_change` (default: the result differs from last time), `when_true` (the script returns `{wake: true, summary}`), `always`, or `never` (log only) |
| `instruction` | what Hermes should do when woken; stored with the schedule and included in the wake message |
| `expires` | default 30 days; `max_runs` is optional |

### Managing schedules: list and remove

Hermes must be able to find schedules that are no longer needed and remove
them, without relying on you to tidy up. Every schedule gets a stable `id`
(e.g. `s_3f9a`) as well as its `name`.

**`list_schedules {conversation?: "this" | "all", status?}`** (auto,
read-only). Returns, for each schedule:

| Field | Meaning |
|---|---|
| `id`, `name` | the stable id and the label |
| `site`, `schedule` | the approved origin and the schedule as given |
| `conversation` | which conversation it wakes, and `this: true` when it's the current one |
| `created`, `expires` | when it was made and when it lapses |
| `status` | `active`, `paused`, `failing` (auto-paused after errors) or `expired` |
| `runs`, `wakes` | counts so far |
| `last_run`, `last_wake`, `next_run` | timestamps |
| `last_result` | a short excerpt (redacted) |
| `last_error` | the last failure, if any |
| `instruction` | what Hermes asked to do when woken |

`conversation: "this"` is the default, so Hermes normally sees its own.

**`cancel_schedule {ids: [...]}`** (auto: removing is always safe). Takes one
or several ids or names. It deletes the schedule, its alarm and its stored
results, and returns what was removed. If an id is unknown or already gone,
that's reported, not treated as an error.

**`pause_schedule` / `resume_schedule {ids}`** (auto). Resuming an expired or
failing schedule keeps its approval, as long as the script and site haven't
changed.

**`schedule_script` with an existing `name`** in the same conversation
replaces that schedule instead of adding a duplicate. This needs a new
approval card, which shows the difference from the old version.

### Helping Hermes notice schedules that are no longer used

- **In the context.** The sidebar's context line, sent to Hermes each turn
  (`context.update`), names the schedules tied to the current conversation:
  `schedules: price-watch (hourly, last woke 2 d ago), ci-watch (paused)`.
  Hermes doesn't need to remember them across compressions or sessions.
- **In every wake message.** Each wake ends with: "If this schedule has done
  its job, remove it with `cancel_schedule {ids: ["s_3f9a"]}`." A one-off
  goal ("tell me when it drops below £50") then gets cleaned up in the same
  turn that reports it.
- **When `when_true` fires.** The script can return `{wake: true, done: true}`
  to say the goal is met. The schedule pauses itself after this wake, and
  Hermes is told so.
- **Stale schedules.**
  - These are schedules that haven't woken Hermes in 14 days, or whose
    conversation was deleted.
  - They're marked `stale: true` in `list_schedules`.
  - They're named in the context line as "(stale)".
  - Settings shows them in their own group, with "Remove all stale".
- **Failing schedules.**
  - Ten failures in a row (site gone, script throws, origin moved) pause a
    schedule as `failing`.
  - You get one notification.
  - Hermes sees the status and `last_error` and can fix or remove it.
- **Expiry.** This is the backstop: nothing runs past `expires` (30 days by
  default) without being renewed.

### How a run works

1. **Waking up.** `chrome.alarms` wakes the service worker on time. Missed
   runs (laptop asleep) collapse to a single run on wake. Alarms are
   persistent and survive browser restarts.
2. **Finding the tab.** For `{url}`, the page opens in an inactive tab in a
   collapsed **"Scheduled" tab group** in the last-focused normal window. The
   group is created on first use and reused afterwards. The tab closes after
   the run, and the group disappears when empty. If no normal window is open,
   the run waits for one, up to the next scheduled run. For `{match}`, the
   oldest open tab that matches is used; if none is open, the run is skipped.
   Tab groups are already used by `group_tabs` (proposal 7). They avoid a
   second window, and a background tab in a normal window is throttled less
   than a minimized window.
3. **Checking the site.** The script runs only if the tab's origin still
   matches the one approved. A redirect elsewhere means the run is skipped
   and logged.
4. **Running.** The script runs through `chrome.debugger` `Runtime.evaluate`,
   like `run_js`. MV3 forbids `eval` in extension pages, and page CSPs block
   `new Function`. Runs time out after 30 s and results are capped at 20 KB.
5. **Recording.** Personal data in the result is redacted under the usual
   settings. The result is kept locally: the last 20 runs per schedule.
6. **Waking Hermes.** If the `wake` condition holds, the result goes to
   Hermes (next section).

### Waking Hermes

**Delivery.**
- **Connecting on wake.** The service worker connects only when a run's
  wake condition holds, and never holds a connection open. It opens a
  short-lived outrigger connection as client `hermes-sidebar-scheduler`,
  with the `chat` capability, the same endpoint and key or token as the
  panel, and no tools. It then:
  1. sends `chat.send` to the chat the schedule was created in, which runs a
     Hermes turn;
  2. waits for `chat.accepted`;
  3. stays connected while that turn's reply streams, up to 5 minutes, so
     the reply reaches the notification;
  4. disconnects.

  An open panel has its own connection and shows the reply live; otherwise it
  appears when you open the panel (the conversation is stored). MV3 keeps the
  service worker alive while the WebSocket is active (Chrome 116+).
- The wake message:
  ```
  [Scheduled check "price-watch" · 2026-11-18 09:00 · example.com]
  Result (untrusted page data): {"price": 47.99, "was": 52.00}
  Your instruction when you scheduled this: tell me if it drops below £50.
  If this schedule has done its job, remove it with cancel_schedule {ids: ["s_3f9a"]}.
  ```
- Hermes's reply appears in that conversation, as a desktop notification
  (proposal 8), and in the panel when you next open it.

**Offline.** If the gateway is unreachable, results queue locally (50 at
most) and are delivered on reconnect, marked as late.

**Cost cap.** At most 24 wakes a day per schedule and 100 overall (settings).
Beyond that, results are only logged and you get a notification that the
cap was hit.

### Safety

A schedule is persistent code execution in your logged-in browser, so it
asks more of you than `run_js`:

- **Creation.** You approve every schedule on a card that shows the name, site,
  schedule, wake mode, instruction and the **full script**. The approval
  covers that script's hash on that origin only. Any change needs a new card,
  and the reviewer can't auto-approve schedules.
- **Unattended turns are narrowed (plugin).** A woken turn has nobody
  watching, and its input is page data that could contain prompt injection.
  - The plugin marks scheduler chats (chat id prefix `sched:`).
  - Its `toolsets_for_source()` gives those turns `scheduled_toolsets`
    (default `[web, outrigger, no_mcp]`) even for the owner, so a page
    can't steer an unattended turn into the terminal.
  - Browser actions in that turn still need a card. Nobody is there, so the
    card waits with a notification and the call times out if ignored.
- **Limits.**
  - At most 20 schedules.
  - The minimum interval is 5 minutes. It can go down to 1, since
    `chrome.alarms` allows 30 s.
  - Schedules expire after 30 days unless renewed, and an expiry notice
    shows a day before.
- **Visibility.**
  - Settings gets a "Schedules" section: each schedule with its script, last
    result and next run, plus run now, pause, edit (re-approve) and delete.
  - A "Pause all" kill switch, also on the action icon's right-click menu.
  - A badge on the toolbar icon while any schedule is active.
- **The debugger banner.** `chrome.debugger` shows a "started debugging this
  browser" banner during each run. It's honest, but noisy for frequent
  schedules; S3 looks at quieter ways to run scripts.

### Plugin side

- Scheduler chats are recognised by the `sched:` chat id prefix. They get
  `scheduled_toolsets` through `toolsets_for_source()`, the same public hook
  used for paired users.
- A `scheduled_wakes_per_hour` cap (default 20) is enforced on the gateway
  too, so a buggy or compromised client can't run up model costs.
- The owner's `HOME` chat isn't used. Wakes go to the schedule's own
  conversation, so context stays together.

### Phases

- **S1, schedules and runs, without waking Hermes.**
  - `schedule_script`, `list_schedules`, `cancel_schedule` and
    `pause_schedule` / `resume_schedule`.
  - The approval card, alarms, the tab-group runner and the local results
    log.
  - Stale and failing flags, and the context line.
  - The settings section and kill switch.
  - Hermes can create schedules and read results with `list_schedules`.
- **S2, waking Hermes.**
  - The background connection, `wake` conditions and the offline queue.
  - Notifications, and the plugin's `scheduled_toolsets` and wake cap.
- **S3, more.**
  - `cron` syntax and `{at}` one-offs.
  - Per-run diffs ("what changed" fed to Hermes).
  - Quieter execution for allow-listed sites: a content script with fixed
    extractors, such as CSS selectors, instead of free JavaScript.

### Decisions (2026-11-17)

- **Lifecycle:** Hermes can list (`list_schedules`) and remove
  (`cancel_schedule`, several at once) schedules it no longer needs. It's
  reminded through the context line and every wake message. Stale and
  failing schedules are flagged; expiry is the backstop.
- **Where runs happen:** a collapsed "Scheduled" tab group in the
  last-focused window, not a separate minimized window.
- **Connection:** connect on wake only; no standing background connection.

### Open question

- Should schedules be allowed to act (click or fill), or only read?
  Proposed: read-only in S1 and S2. Acting goes through a woken Hermes turn,
  with cards.

### Testing

- **Fake timers:** alarms fire, missed runs collapse, the origin check holds
  across redirects, and runs time out.
- **Wake conditions:** `on_change`, `when_true` (with and without `done`),
  `always` and `never`, plus the cost caps.
- **Lifecycle:**
  - `list_schedules` for this conversation and for all of them;
  - `cancel_schedule` with several ids, including unknown ones;
  - replacing a schedule by name (re-approval with a diff);
  - stale after 14 days without a wake, and when the conversation is deleted;
  - auto-pause after 10 failures;
  - the context line names this conversation's schedules.
- **Tab group:** created once and reused, collapsed, the tab closed after
  the run and the group removed when empty; a run with no window open waits.
- **Connect on wake:** no socket while idle. On wake the worker connects,
  sends, receives the streamed reply, notifies and disconnects. Offline
  results queue and are delivered late.
- **End to end:** the real extension, with the stand-in gateway and a local
  test page whose "price" changes. A wake reaches the platform as a
  `sched:` chat, with narrowed tools and a notification.

## 16. Use the agent's name, not just "Hermes"

Date: 2026-11-17. Status: proposed.

Your agent has a name: Sorrel, from `SOUL.md`. The sidebar still says "Ask
Hermes…", "Hermes is working on…" and so on, and the manifest and README
hard-code "Hermes (Sorrel)". Instead, the plugin tells clients the agent's
name and the interface uses it everywhere.

### Where the name comes from

- **Plugin setting `agent_name`** (and optional `agent_avatar`, an emoji or
  `https` image URL). It's explicit, and it uses only public APIs.
- **Not parsed from `SOUL.md`.** That's free text: "You are Sorrel (she/her),
  …" could change, or name other agents.
- **Not read from Hermes's skin branding.** Hermes has a branding
  `agent_name`, but only through `hermes_cli.skin_engine`, which isn't part
  of the plugin API. If upstream adds a public accessor (for example
  `ctx.branding("agent_name")`), the setting would default to it. That could
  be raised alongside the command-catalog issue (#149673).

### Protocol

`welcome` gains `agent: {name, avatar?}`. The default name is "Hermes".
Clients cache it in `chrome.storage` so the interface is named correctly
before connecting and while offline.

### Sidebar: where the name appears

- **Panel:**
  - the input placeholder ("Ask Sorrel…");
  - the empty state;
  - the lock bar ("Sorrel is working on…") and "Undo Sorrel";
  - note prompts ("What should Sorrel do with it?").
- **Prompt cards:** "Sorrel asks", "Sorrel wants to run a command".
- **Right-click menu:** "Ask Sorrel about this page", and the other
  entries. The service worker updates the titles with
  `chrome.contextMenus.update` when the name changes.
- **Toolbar icon:** the tooltip, via `chrome.action.setTitle`.
- **Notifications** ("Sorrel replied").
- **Settings descriptions** ("Let Sorrel use this browser").

**Unchanged.** References to the software, not the agent: the extension's
name "Hermes Sidebar", "Hermes gateway", "Hermes host", the outrigger plugin
and `API_SERVER_KEY`. The manifest's `name` and `description` are static and
can't change at runtime. They become neutral ("Hermes Sidebar: ask your
Hermes agent about the page you're reading").

**Pronouns.** The interface is written without pronouns for the agent ("Sorrel
is working on…", not "she is…"). The name alone doesn't say how the agent is
referred to, and pronoun-free text works for any name.

### Plugin side

- The `agent_name` and `agent_avatar` settings, and the `welcome.agent` field.
- `platform_hint` and the notebook command messages already say "Hermes" to
  the model; those stay as they are. The model knows its own name from
  `SOUL.md`.

### Phases

- **A1:**
  - the setting and `welcome.agent`;
  - the sidebar strings, plus the context menu and toolbar title updates;
  - the manifest and README made neutral.
- **A2:** default to Hermes's branding name if a public API appears upstream.

### Testing

- **Unit:** `welcome.agent` with and without the setting.
- **Extension:** with `agent_name: Sorrel`, the placeholder, menus, the
  action title, cards, the lock bar and notifications all say Sorrel. After
  a reload while offline, the cached name is still used.

---

# Round 3 (2026-11-17)

Proposals 17-24 are next up; 25-26 are low priority. All are proposed, none
built. Each builds on something that already exists (the notebook, the
right-click menu, the `run_js` runner, the screenshot file path, tab groups,
notifications).

## 17. Clip to notes

Save the current page, the selection, a link or an image into a vault note
from the right-click menu. Today, getting something from the browser into
your notes means copying by hand or asking Hermes in chat.

**Right-click menu.** A "Save to notes" submenu:

- **Append to today's note**, using the daily-note template (below).
- **Append to the open note** (Notebook mode's current note), when one is
  open.
- **New note…**, which asks for a title in a small panel prompt.
- **Summarise and file…**, which sends a `//`-style instruction to the agent
  with the clipped content, e.g. "summarise this into my reading list".

**What's saved** (Markdown):
```markdown
## <page title>
<selection as a quote, or a page excerpt, or the link/image>
— [source](<url>) · 2026-11-17 14:02
```
Selections keep their structure: links, lists and code become Markdown, and
nothing is sent to the model. "Whole page" uses the same readable-text
extraction as `get_page`.

**Settings:**
- the default action;
- the daily-note path template (`Daily/{yyyy}-{mm}-{dd}.md`);
- the clip template;
- which notebook root to use.

**Plugin side (Notebook).**
- **New messages:**
  - `doc.append {root, path, text}`: an atomic append that creates the file
    if needed, without a full-text round trip;
  - `doc.create {root, path, text}`: refuses to overwrite.
- **Checks:** the same path rules, `notebook_max_bytes` and per-user roots.
- **Live:** an open copy of the note updates through `doc.changed`.

**Safety.** Clipping is local text into your own vault: no model call and no
approval card. Redaction doesn't apply, because the text doesn't go to the
model. "Summarise and file" goes through the normal turn, with redaction.

**Phases:** C1 the menu, append, today's note and new note. C2 "summarise and
file", templates, and image clips (saved next to the note as files).

## 18. Rewrite in place (any text field)

Right-click in a text box, or press a shortcut, then choose **"Rewrite with
\<agent>"**: fix, shorten, make it friendlier or more formal, or a custom
instruction. The suggestion appears as an inline diff next to the field.
**Accept** writes it back; **Discard** leaves the field untouched. Most
writing in the browser (email, comments, PRs, tickets) happens in other
sites' fields.

**How it works:**
- **Reading the field.** A content script reads the focused `textarea`,
  `input` or `contenteditable` element: its text, the selection if any, and
  enough surrounding context (e.g. the email being replied to, capped).
- **The request.** It goes to the agent on its own chat, `rw:<id>`. Results
  stream into the popover, which lives in a shadow DOM so the page's styles
  can't break it.
- **Writing back.** Accept uses `execCommand('insertText')` or the field's
  native setter plus `input` events. That keeps the field's undo history,
  and frameworks such as React and the editors in Gmail and GitHub see the
  change. Ctrl+Z still works.

**Safety:**
- **Narrowed toolsets.** The surrounding context may be someone else's text,
  like the email you're replying to. So `rw:` chats get no tools through the
  plugin's `toolsets_for_source()`: setting `rewrite_toolsets`, default
  `[no_mcp]`. It's plain text in, plain text out.
- **Redaction.** It applies to the text sent, and placeholders are restored
  in the suggestion before it's shown, so names and emails come back as they
  were.
- **No silent changes.** Nothing is written without Accept, and password
  fields are never read.

**Phases:** R1 `textarea` and `input`, with fixed actions plus a custom
instruction. R2 `contenteditable` (Gmail, GitHub, Notion), the keyboard
shortcut and the surrounding context.

## 19. PDFs and documents

Chrome's PDF viewer is closed to extensions, so `get_page` fails on PDFs, one
of the most common things to ask about. A new tool, **`get_document {tab?,
pages?}`**:

1. **Fetch.** It fetches the current tab's PDF with your session: from the
   extension, using host permissions, or failing that from the page context,
   for files behind cookies only the page sends. It also handles `file://`
   PDFs when "Allow access to file URLs" is on.
2. **Extract.** It extracts text in the browser with **pdf.js** (Apache-2.0,
   vendored and credited in About), page by page, with `pages` ranges and the
   usual result cap. Extracting in the browser means redaction works on PDFs
   too.
3. **Optionally keep the file.** With `keep_file: true`, it sends the
   original to the plugin, which saves it like screenshots
   (`plugin-data/outrigger/documents/`, size-capped, newest N) and returns
   `file_path` for Hermes's own tools. Tables and figures survive better
   that way.

**Also covered:** Google Docs, Sheets and Slides through their export URLs
(`/export?format=txt|csv|pdf`), fetched with your session.

**Policy.** Reading the current tab's document is like `get_page`, so it's
auto-approved. `keep_file` uploads a file to the host, so it uses the
"screenshots" confirm class.

**Phases:** D1 PDFs (text and pages). D2 `keep_file` and Google exports.

## 20. Fetch as me

**`fetch_url {url, as?: "text" | "json" | "html", max_chars?}`** fetches a URL
through your logged-in browser without opening a tab. Uses:
- an intranet page;
- a JSON API behind login;
- "the CSV linked on this page";
- a status endpoint for a scheduled script.

**How it works:**
- **Same-origin requests** run in the page context (via the debugger, like
  `run_js`), so cookies and CSRF behave as the site expects.
- **Other origins** run from the extension, using host permissions.
- **Requests:** `GET` only (`HEAD` later), a 15 s timeout, a 2 MB download
  cap, and HTML turned into readable text.
- **Results** are redacted and capped like any tool result.

**Policy:**
- **New confirm class, "fetch".** Each site is granted per conversation, as
  for actions. The reviewer may auto-approve `GET`s to sites already granted
  in the conversation.
- **Redirects.** A redirect to another origin is reported, not followed.
- **No local network.** `localhost` and private ranges are blocked unless you
  allow them in settings, so a page can't use Hermes to probe your network.

**Phases:** F1 `GET` with text, JSON and HTML. F2 `HEAD`, and usable from
scheduled scripts (15).

## 21. Files in and out

**`download {name, content | path, mime?}`** puts something the agent produced
(CSV, Markdown, a generated image) into your Downloads folder.
- **Content:** inline content up to 1 MB. Larger files come from a `path` on
  the host, which the plugin reads only if Hermes's own media path checks
  allow it (`validate_media_delivery_path`, as for `send_document`).
- **Permission:** `chrome.downloads`, an optional permission requested when
  you turn the feature on.
- **Policy:** confirm class "files". The card shows the name, size and type.

**`upload_file {selector | ref, path}`** attaches a host file to a form's file
input.
- **How:** the plugin reads the file (same path checks), the sidebar builds a
  `File`, assigns it through `DataTransfer` and fires `change`. This works on
  most sites without the debugger. `DOM.setFileInputFiles` isn't usable
  here, because it needs a path on the browser's machine.
- **Policy:** always a card showing the file name, size and target site.
  Uploading is never auto-approved.

**Phases:** U1 `download`. U2 `upload_file`.

## 22. Read many tabs at once

**`read_tabs {tabs?: [ids] | group?: name | window?: "current", mode?: "text" |
"snapshot", max_chars_per_tab?}`** reads several tabs in one call, in
parallel, with a shared size budget split across tabs. It's for "compare
these five products" or "summarise everything I opened about X" without
eight round trips and a full context.

- **Skipped:** Chrome pages and other unreadable tabs, listed with a reason.
- **Discarded tabs:** they aren't woken, unless `wake: true`.
- **Redaction** applies per tab, with each tab's own site setting.
- **Policy:** like `get_page` (auto). Reading tabs in other windows (`window:
  "all"`) needs a card once per conversation.

## 23. Address-bar shortcut

Type **`h` then Space** in Chrome's address bar, then a question, to ask the
agent straight away.
- **Suggestions:** "Ask Sorrel: \<text>". Typing `h /` lists slash commands
  from the command catalog.
- **Enter** opens the side panel and sends the question with the current
  tab as context. "Ask in a new conversation" is the second suggestion.

**Notes:**
- **The keyword is fixed.** It's set in the manifest (`omnibox.keyword`),
  can't change at runtime and so can't be the agent's name. `h` is short;
  proposal 16's name appears in the suggestion text instead.
- **Opening the panel.** `chrome.sidePanel.open` needs a user gesture.
  Whether pressing Enter in the address bar counts needs testing. If it
  doesn't, a notification is shown instead ("Sorrel is answering, click to
  open"), using 24.

## 24. System notifications: approvals, prompts and replies

**Today:** a notification appears only when a long reply finishes while the
panel is hidden (proposal 8). That leaves gaps:
- **Approvals.** A card that needs you (an approval, `reveal`, clarify, a
  choice) waits silently if you're in another window. Calls time out (60 s
  by default), and Hermes gives up.
- **Panel closed.** Anything Hermes sends while the panel is closed, such as
  results from its own cron jobs or replies to scheduled wakes (15), is only
  seen when you next open the panel.

**A. Cards that need you.** When a card appears and the panel isn't the
focused, visible window:
- **Approval:** "Sorrel wants to click 'Submit' on example.com". The
  buttons are **Open** and **Deny**. **Approve isn't offered in the
  notification:** you should see the details on the card first. The
  exception is classes the reviewer already approved, a setting that's off
  by default.
- **Reveal, clarify and choice:** "Sorrel needs your answer", with **Open**.
- **`//` note commands** waiting on a prompt: "Sorrel needs you in
  \<note>".
- **Persistence.** Notifications stay until acted on
  (`requireInteraction`), and are cleared or updated when the card is
  answered in the panel, cancelled or times out ("Timed out: Sorrel
  continued without it").
- **Open.** It focuses the window and opens the side panel on the card
  (`sidePanel.open` from the notification click; needs testing as a user
  gesture).
- **Combined.** Several pending cards become one notification: "3 things
  need you".

**B. Messages while the panel is closed** (with "connect on wake", no
standing connection):
- **Checking in.** A `chrome.alarms` check every N minutes (default 5, or
  off). It connects, flushes the outbox for your home chat and any chat with
  queued replies, shows them as notifications ("Sorrel: Your 9:00 report is
  ready") and disconnects. The plugin already queues replies per chat
  (`OUTBOX`, 50 per chat); a `chat.peek` message, which lists chats with
  queued replies, lets the check avoid attaching to everything.
- **Clicking** opens the panel on that conversation.
- **Scheduled wakes (15)** use the same path for their replies.

**Settings** (Chat → Notifications):
- separate switches for long replies (existing), cards that need you, and
  messages while the panel is closed (with the check interval);
- "Show message text in notifications": on by default; turn it off for
  privacy on shared screens.

**Platform notes:**
- **Linux:** Chrome uses the desktop's native notifications. Buttons depend
  on the notification daemon (mako supports actions through `makoctl`). If
  they don't show, clicking still opens the panel.
- **Do-not-disturb:** respected by the OS.

**Phases:** N1 cards that need you (A). N2 messages while closed (B),
`chat.peek` in the plugin, and scheduled-wake replies.

## 25. "Watch me do it" — low priority

Record your clicks, typing and navigation on a site as a named workflow
("submit my timesheet"). Hermes can then replay it (each step with the usual
cards, or a single card for the whole workflow), adapt it ("do it for last
week"), or turn it into a scheduled script (15).

**Hard parts:**
- **Recordings capture sensitive input.** Typed values are stored as
  placeholders with redaction categories, and password fields are never
  recorded.
- **Selectors break when sites change.** Recordings store snapshot refs and
  text labels, not CSS paths, and replay re-resolves them each time.
- **Replay must stop on surprises:** an unexpected page or a missing
  element.

Worth doing after 15 and 20, which provide most of the plumbing.

## 26. Page annotations — low priority

The agent leaves comments on a page: "this clause conflicts with §4", "this
price is higher than last week". They show as margin notes anchored to the
text, kept per URL in local storage, and reappear when you return.

- **Builds on `highlight`.** Text-quote anchors, the same approach as the
  W3C Web Annotation model, re-find the passage after small page changes.
- **Controls:** a panel list "Notes on this page" and a toggle to hide them.
- **Sync:** an optional copy into the vault via 17, as a note per site.

## Considered: site-specific readers (YouTube, GitHub, long threads)

Mostly covered by Hermes skills already:
- **`youtube-content`** fetches transcripts on the host.
- **`github`** uses `gh` for PRs, issues and diffs.
- **`attached-browser-research`** covers reading the attached browser.

The gaps are small:
- **Private content.** The skills run on the host, so they can't see what
  only your browser's logins can.
- **Paired users.** The skills use `terminal`, which paired users don't
  have.

Better than new tools: add site recipes to `attached-browser-research`, for
example how to read a long Slack or Discord thread or an infinite-scroll
feed with `snapshot` and `scroll`, or a private repo's PR diff from the page.
Build a dedicated extractor only if a recipe proves too slow or unreliable.
