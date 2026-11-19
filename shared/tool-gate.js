/* Tool approval gate — the authorization vocabulary and the pure decision logic
   for browser-tool calls from Hermes. Audit: see AUDIT.md#tool-approval-gate
   (trust boundary: gateway/model tool call -> user-approved browser action).

   Responsibility: decide WHETHER a call needs the user's Allow card, a
   conversation grant, or reviewer auto-approval — and which classes may ever
   be granted or reviewer-approved. Pure functions of their inputs: no DOM, no
   storage, no live panel state; the caller (panel.js handleCall) supplies the
   current grants/reviewerAuto and acts on the decision.

   Deliberately does NOT: render cards, store grants, unredact arguments, or
   execute tools — those stay in panel.js / browser-tools.js. It also does not
   decide redaction (redactor.js) or sanitize replies (markdown.js).

   Invariants (pinned by tests/tool-gate.test.mjs against the pre-extraction
   logic over the full input matrix):
   - a call that puts redacted values into a site (DISCLOSING_TOOLS) ALWAYS
     asks: no grant, no reviewer bypass, even for policy-'auto' tools;
   - a reviewer 'deny' verdict always reaches the user (grants do not apply);
   - reviewer auto-approve is limited to REVIEWER_CLASSES and the reviewerAuto
     setting; code execution is never reviewer-approved;
   - per-site grants never apply to classes that reach beyond one site
     (NO_GRANT_CLASSES), nor to flagged calls, nor without an origin. */

// Approval classes for "confirm" tools. Grants and reviewer auto-approval work per class.
const TOOL_CLASS = { click: 'act', fill: 'act', fill_form: 'act', open_url: 'navigate', run_js: 'code', fetch_as_user: 'navigate', reveal: 'reveal',
  screenshot: 'capture', dev_watch: 'debug', search_history: 'personal', search_bookmarks: 'personal' };
const CLASS_LABEL = { act: 'page actions', navigate: 'opening pages', code: 'running code', reveal: 'revealing data',
  capture: 'screenshots', debug: 'debugging', personal: 'history and bookmarks' };
// Classes that never get a per-site grant: they reach beyond one site.
const NO_GRANT_CLASSES = new Set(['reveal', 'personal']);
// Classes Hermes's reviewer may approve without a card. Code always needs the user
// (or a grant): it runs with the user's cookies, the main exfiltration risk.
const REVIEWER_CLASSES = new Set(['act', 'navigate']);
// Tools whose arguments reach a site: putting a real value there discloses it, so a
// call that uses redacted values always asks (no reviewer approval, no grant).
const DISCLOSING_TOOLS = new Set(['fill', 'fill_form', 'open_url', 'fetch_as_user']);

// A conversation grant is keyed by class + origin ("act|https://example.com").
const grantKey = (cls, origin) => cls + '|' + origin;

/* The approval decision for one tool call.
   Actor: Hermes (via the gateway) supplies tool/args/review verdict; the user's
   settings and prior grants supply the rest. Input (all explicit):
     policy        BROWSER_TOOL_POLICY[tool] ('auto' | 'confirm')
     disclosing    the call uses redacted values AND tool is in DISCLOSING_TOOLS
     reviewVerdict the gateway reviewer's verdict ('approve'|'escalate'|'deny'|undefined)
     cls, origin   TOOL_CLASS[tool] and the site the call acts on ('' if unknown)
     granted       a conversation grant exists for grantKey(cls, origin)
     reviewerAuto  the user's "let the reviewer approve" setting
   Returns { mode }:
     'auto'     run without asking (policy auto, no PII disclosure)
     'disclose' always ask; no grant button, no reviewer bypass (PII goes to a site)
     'granted'  a conversation grant covers this class+origin
     'reviewed' reviewer approved and the class allows it
     'prompt'   the user must Allow/Deny (flagged calls land here too) */
function decideApproval({ policy, disclosing, reviewVerdict, cls, origin, granted, reviewerAuto }) {
  if (policy === 'auto' && !disclosing) return { mode: 'auto' };
  if (disclosing) return { mode: 'disclose' };
  const flagged = reviewVerdict === 'deny';
  if (!flagged && cls && origin && granted) return { mode: 'granted' };
  if (reviewerAuto && reviewVerdict === 'approve' && REVIEWER_CLASSES.has(cls)) return { mode: 'reviewed' };
  return { mode: 'prompt' };
}

// Whether the Allow card may offer "Allow <class> on <site>" for the conversation.
// Never for flagged calls, missing origin, or classes that reach beyond one site.
function canOfferGrant({ cls, origin, flagged }) {
  return Boolean(cls && origin && !flagged && !NO_GRANT_CLASSES.has(cls));
}

// Whether a reveal call may skip the card: every asked value was opted into
// "don't ask again" AND the reviewer did not flag the call.
function canAutoReveal({ reviewVerdict, placeholders, always }) {
  return reviewVerdict !== 'deny' && placeholders.every(ph => always.has(ph));
}
