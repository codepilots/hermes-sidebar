/* Safety net for the tool-approval gate extraction (refactor-for-human-audit).
   The decision logic moves from panel.js (handleCall/confirmCard/revealCall)
   into shared/tool-gate.js as pure functions. Behavior preservation is proven
   exhaustively: REF_* below is transcribed verbatim from the pre-refactor code
   (git HEAD at the extraction commit) and compared against the new module over
   the full input matrix. Characterization tests pin the human-readable rules.
   Run: node --test tests/tool-gate.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const SRC = readFileSync(path.join(root, 'shared/tool-gate.js'), 'utf8');

const sandbox = { console, Set, URL };
vm.createContext(sandbox);
vm.runInContext(SRC + `
globalThis.__tg = { TOOL_CLASS, CLASS_LABEL, NO_GRANT_CLASSES, REVIEWER_CLASSES,
  DISCLOSING_TOOLS, grantKey, decideApproval, canOfferGrant, canAutoReveal };`, sandbox);
const TG = sandbox.__tg;

/* ---------- REFERENCE: transcribed from pre-extraction HEAD ---------- */
/* panel.js handleCall (the branch inside `policy !== 'auto' || disclosing`):
     const flagged = m.review?.verdict === 'deny';
     if (disclosing) { ...always prompt... }
     else if (!flagged && cls && origin && grants.has(key)) { via granted }
     else if (reviewerAuto && m.review?.verdict === 'approve' && REVIEWER_CLASSES.has(cls)) { via reviewed }
     else { ...prompt... }
   Outside that branch (policy === 'auto' && !disclosing): no approval at all. */
const REF_REVIEWER_CLASSES = new Set(['act', 'navigate']);
function refDecide({ policy, disclosing, reviewVerdict, cls, origin, granted, reviewerAuto }) {
  if (!(policy !== 'auto' || disclosing)) return 'auto';
  const flagged = reviewVerdict === 'deny';
  if (disclosing) return 'disclose';
  if (!flagged && cls && origin && granted) return 'granted';
  if (reviewerAuto && reviewVerdict === 'approve' && REF_REVIEWER_CLASSES.has(cls)) return 'reviewed';
  return 'prompt';
}
/* panel.js confirmCard: grant button offered iff
   `cls && origin && !flagged && !NO_GRANT_CLASSES.has(cls)` */
const REF_NO_GRANT = new Set(['reveal', 'personal']);
const refCanOfferGrant = ({ cls, origin, flagged }) => Boolean(cls && origin && !flagged && !REF_NO_GRANT.has(cls));
/* panel.js revealCall: auto-allow iff
   `m.review?.verdict !== 'deny' && known.every(ph => redactor.always.has(ph))` */
const refCanAutoReveal = ({ reviewVerdict, placeholders, always }) =>
  reviewVerdict !== 'deny' && placeholders.every(ph => always.has(ph));

/* ---------- exhaustive matrix: new module === HEAD logic ---------- */

test('decideApproval matches the pre-extraction branch over the full matrix', () => {
  const policies = ['auto', 'confirm', undefined];
  const verdicts = ['approve', 'escalate', 'deny', undefined];
  const classes = ['act', 'navigate', 'code', 'reveal', 'personal', 'capture', 'debug', undefined];
  let n = 0;
  for (const policy of policies)
    for (const disclosing of [false, true])
      for (const reviewVerdict of verdicts)
        for (const cls of classes)
          for (const origin of ['https://example.com', ''])
            for (const granted of [false, true])
              for (const reviewerAuto of [false, true]) {
                const input = { policy, disclosing, reviewVerdict, cls, origin, granted, reviewerAuto };
                const expected = refDecide(input);
                const actual = TG.decideApproval(input).mode;
                assert.equal(actual, expected, JSON.stringify(input));
                n++;
              }
  assert.equal(n, 1536);
});

test('canOfferGrant matches confirmCard over the full matrix', () => {
  const classes = ['act', 'navigate', 'code', 'reveal', 'personal', 'capture', 'debug', undefined];
  let n = 0;
  for (const cls of classes)
    for (const origin of ['https://example.com', ''])
      for (const flagged of [false, true]) {
        const input = { cls, origin, flagged };
        assert.equal(TG.canOfferGrant(input), refCanOfferGrant(input), JSON.stringify(input));
        n++;
      }
  assert.equal(n, 32);
});

test('canAutoReveal matches revealCall over verdicts and always-subsets', () => {
  const phs = ['⟦EMAIL_1⟧', '⟦PHONE_1⟧', '⟦CARD_1⟧'];
  for (const reviewVerdict of ['approve', 'escalate', 'deny', undefined])
    for (let mask = 0; mask < 8; mask++) {
      const always = new Set(phs.filter((_, i) => mask & (1 << i)));
      for (const placeholders of [phs, phs.slice(0, 1), []]) {
        const input = { reviewVerdict, placeholders, always };
        assert.equal(TG.canAutoReveal(input), refCanAutoReveal(input), JSON.stringify(input));
      }
    }
});

/* ---------- vocabulary identity with HEAD ---------- */

test('approval vocabulary is unchanged from browser-tools.js/panel.js at HEAD', () => {
  assert.deepEqual({ ...TG.TOOL_CLASS }, {
    click: 'act', fill: 'act', fill_form: 'act', open_url: 'navigate', run_js: 'code',
    fetch_as_user: 'navigate', reveal: 'reveal', screenshot: 'capture', dev_watch: 'debug',
    search_history: 'personal', search_bookmarks: 'personal' });
  assert.deepEqual({ ...TG.CLASS_LABEL }, {
    act: 'page actions', navigate: 'opening pages', code: 'running code', reveal: 'revealing data',
    capture: 'screenshots', debug: 'debugging', personal: 'history and bookmarks' });
  assert.deepEqual([...TG.NO_GRANT_CLASSES].sort(), ['personal', 'reveal']);
  assert.deepEqual([...TG.REVIEWER_CLASSES].sort(), ['act', 'navigate']);
  assert.deepEqual([...TG.DISCLOSING_TOOLS].sort(), ['fetch_as_user', 'fill', 'fill_form', 'open_url']);
  assert.equal(TG.grantKey('act', 'https://example.com'), 'act|https://example.com');
});

/* ---------- characterization: the rules a human auditor reads ---------- */

const D = (over = {}) => TG.decideApproval({
  policy: 'confirm', disclosing: false, reviewVerdict: undefined,
  cls: 'act', origin: 'https://example.com', granted: false, reviewerAuto: true, ...over,
}).mode;

test('auto tools run without approval; disclosing auto tools still ask', () => {
  assert.equal(D({ policy: 'auto' }), 'auto');
  // fetch_as_user is policy 'auto' but uses redacted values -> always asks
  assert.equal(D({ policy: 'auto', disclosing: true, cls: 'navigate' }), 'disclose');
});

test('a conversation grant skips the card, but a flagged call always asks', () => {
  assert.equal(D({ granted: true }), 'granted');
  assert.equal(D({ granted: true, reviewVerdict: 'deny' }), 'prompt');
});

test('reviewer auto-approve is limited to act/navigate and the reviewerAuto setting', () => {
  assert.equal(D({ reviewVerdict: 'approve' }), 'reviewed');
  assert.equal(D({ reviewVerdict: 'approve', cls: 'code' }), 'prompt');
  assert.equal(D({ reviewVerdict: 'approve', cls: 'personal' }), 'prompt');
  assert.equal(D({ reviewVerdict: 'approve', reviewerAuto: false }), 'prompt');
  assert.equal(D({ reviewVerdict: 'escalate' }), 'prompt');
});

test('PII disclosure bypasses grants and reviewer approval entirely', () => {
  assert.equal(D({ disclosing: true, granted: true, reviewVerdict: 'approve' }), 'disclose');
  assert.equal(D({ disclosing: true, reviewVerdict: 'deny' }), 'disclose');
});

test('grant offers: never for flagged calls or cross-site classes', () => {
  assert.equal(TG.canOfferGrant({ cls: 'act', origin: 'https://x', flagged: false }), true);
  assert.equal(TG.canOfferGrant({ cls: 'act', origin: 'https://x', flagged: true }), false);
  assert.equal(TG.canOfferGrant({ cls: 'personal', origin: 'https://x', flagged: false }), false);
  assert.equal(TG.canOfferGrant({ cls: 'reveal', origin: 'https://x', flagged: false }), false);
  assert.equal(TG.canOfferGrant({ cls: 'act', origin: '', flagged: false }), false);
});

test('reveal auto-allow needs every value opted in and no deny verdict', () => {
  const always = new Set(['⟦EMAIL_1⟧']);
  assert.equal(TG.canAutoReveal({ reviewVerdict: 'approve', placeholders: ['⟦EMAIL_1⟧'], always }), true);
  assert.equal(TG.canAutoReveal({ reviewVerdict: 'approve', placeholders: ['⟦EMAIL_1⟧', '⟦PHONE_1⟧'], always }), false);
  assert.equal(TG.canAutoReveal({ reviewVerdict: 'deny', placeholders: ['⟦EMAIL_1⟧'], always }), false);
});

/* ---------- source pins: wiring invariants that stay in panel.js ---------- */

test('panel.js keeps run_js arguments out of unredaction and redacts results', () => {
  const src = readFileSync(path.join(root, 'shared/panel.js'), 'utf8');
  // run_js args are never unredacted (arbitrary code could exfiltrate real values)
  assert.match(src, /if \(m\.tool !== 'run_js'\) \{\s*\n\s*const u = redactor\.unredactDeep\(m\.args\)/);
  // every handler result goes through redactDeep before leaving the browser
  assert.match(src, /redactor\.redactDeep\(raw, \{ url \}\)/);
  // errors are redacted too
  assert.match(src, /redactor\.redact\(String\(e\.message\), \{ url \}\)/);
  // reveal is the one deliberate unredacted path, and it is per-value approved
  assert.match(src, /Deliberately not redacted/);
});
