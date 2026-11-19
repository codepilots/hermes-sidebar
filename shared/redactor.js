/* Personal-data redaction for everything the sidebar sends to Hermes.
   Audit: see AUDIT.md#redaction (detectors, placeholders, the reveal path).
   Trust boundary: outbound text (page content, tool args/results, errors) is
   replaced with placeholders HERE, in the browser; the value map (byPh) never
   leaves. Deliberately does NOT decide what may be revealed (panel.js revealCall
   asks the user per value) and does not sanitize markup (markdown.js).
   Failure contract: redaction stays ON for invalid/empty URLs (fail-closed);
   only an explicitly skipped site turns it off. An arcjet WASM failure is caught
   and console.warn'd while the other detectors keep working — a known gap the
   security review recommends a loud self-test for.

   Detection:
   - @arcjet/redact (vendor/arcjet-redact.js): email, phone, card number, IP.
     It works token by token, so it is given a copy of the text with brackets and
     punctuation blanked out (same length); the matched strings are then replaced
     in the original text.
   - compromise (vendor/compromise.js): people's names, places (English).
   - Small detectors for what those lack: IBAN (mod-97), UK NI / US SSN, API keys
     and tokens, national phone formats, and form-field values that page-agent.js
     marks by their autocomplete/type (⟪pii:type:value⟫).

   Each distinct value becomes a placeholder like ⟦EMAIL_1⟧, stable for the
   conversation. The map stays in this panel; nothing here is ever sent. */

const PII_CATEGORIES = {
  email:   { label: 'Email addresses', default: true },
  phone:   { label: 'Phone numbers', default: true },
  card:    { label: 'Card numbers', default: true },
  iban:    { label: 'Bank account numbers (IBAN)', default: true },
  ids:     { label: 'ID numbers (NI, SSN)', default: true },
  secrets: { label: 'API keys, tokens and session values', default: true },
  names:   { label: "People's names", default: true },
  fields:  { label: 'Personal form fields (name, address, birthday…)', default: true },
  places:  { label: 'Places (cities, streets)', default: false },
  ip:      { label: 'IP addresses', default: false },
};

const PLACEHOLDER_RE = /⟦([A-Z]+)_(\d+)⟧/g;
const FIELD_MARK_RE = /⟪pii:([a-z]+):([^⟫]*)⟫/g;
const HAS_PLACEHOLDER = /⟦[A-Z]+_\d+⟧/;

// Field marker type -> [category, placeholder prefix]
const FIELD_TYPES = {
  email: ['email', 'EMAIL'], phone: ['phone', 'PHONE'], name: ['fields', 'NAME'],
  address: ['fields', 'ADDRESS'], postcode: ['fields', 'POSTCODE'], card: ['card', 'CARD'],
  dob: ['fields', 'DOB'], secret: ['secrets', 'SECRET'],
};
const ARCJET_TYPES = { 'email': ['email', 'EMAIL'], 'phone-number': ['phone', 'PHONE'],
  'credit-card-number': ['card', 'CARD'], 'ip-address': ['ip', 'IP'] };

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + +d) % 97;
  }
  return rem === 1;
}

const SECRET_RES = [
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}\b/g,                      // JWT
  /\b(?:sk|pk|rk)-(?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{16,}\b/g, // sk-..., sk-live-...
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
// Values of these query/form parameters are secrets: only the value is replaced.
const SECRET_PARAM_RE = /([?&#;](?:access_token|id_token|refresh_token|token|auth|api_key|apikey|key|sig|signature|secret|password|passwd|session|sessionid|sid|code)=)([^&#\s"'<>]{8,})/gi;
const BEARER_RE = /(\bBearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;

const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// National formats Arcjet misses: UK 0xxxx xxxxxx, US (xxx) xxx-xxxx.
const PHONE_EXTRA_RES = [/(?<![\d\w])\(?0\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?![\d\w-])/g, /\(\d{3}\) ?\d{3}-\d{4}\b/g];

class Redactor {
  constructor() {
    this.settings = { enabled: true, cats: Object.fromEntries(Object.entries(PII_CATEGORIES).map(([k, v]) => [k, v.default])), skip: [] };
    this.reset();
  }

  reset() {
    this.byValue = new Map();  // prefix + '\u0000' + value -> placeholder
    this.byPh = new Map();     // placeholder -> { type, value }
    this.counters = {};
    this.shared = new Set();   // placeholders revealed to Hermes
    this.always = new Set();   // placeholders the user lets Hermes have without asking
  }

  /** Conversation state for chrome.storage.session (memory only, cleared with the browser). */
  exportState() {
    return { byPh: [...this.byPh], counters: this.counters, shared: [...this.shared], always: [...this.always] };
  }

  importState(s) {
    this.reset();
    if (!s || !Array.isArray(s.byPh)) return;
    for (const [ph, e] of s.byPh) { this.byPh.set(ph, e); this.byValue.set(e.type + '\u0000' + e.value, ph); }
    this.counters = { ...(s.counters || {}) };
    this.shared = new Set(s.shared || []); this.always = new Set(s.always || []);
  }

  configure({ enabled, cats, skip } = {}) {
    if (typeof enabled === 'boolean') this.settings.enabled = enabled;
    if (cats) this.settings.cats = { ...this.settings.cats, ...cats };
    if (Array.isArray(skip)) this.settings.skip = skip.map(h => String(h).trim().toLowerCase()).filter(Boolean);
  }

  activeFor(url) {
    if (!this.settings.enabled) return false;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch {}
    return !(host && this.settings.skip.some(h => host === h || host.endsWith('.' + h)));
  }

  categories() { return Object.keys(this.settings.cats).filter(k => this.settings.cats[k]); }

  placeholder(prefix, value) {
    const key = prefix + '\u0000' + value;
    let ph = this.byValue.get(key);
    if (!ph) {
      this.counters[prefix] = (this.counters[prefix] || 0) + 1;
      ph = `⟦${prefix}_${this.counters[prefix]}⟧`;
      this.byValue.set(key, ph);
      this.byPh.set(ph, { type: prefix, value });
    }
    return ph;
  }

  lookup(ph) { return this.byPh.get(ph); }

  /** Redact one string. Returns { text, found: [{ ph, type, value }] }. */
  async redact(text, { url = '' } = {}) {
    if (typeof text !== 'string' || !text) return { text, found: [] };
    if (!this.activeFor(url)) return { text: text.replace(FIELD_MARK_RE, (_, t, v) => v), found: [] };
    const on = this.settings.cats;
    const found = new Map();
    const swap = (prefix, value) => { const ph = this.placeholder(prefix, value); found.set(ph, { ph, type: prefix, value }); return ph; };

    // 1. Values page-agent marked by field semantics.
    text = text.replace(FIELD_MARK_RE, (_, t, v) => {
      const [cat, prefix] = FIELD_TYPES[t] || ['fields', 'PII'];
      return v && on[cat] ? swap(prefix, v) : v;
    });

    // 2. Secrets before anything else (URLs can contain emails).
    if (on.secrets) {
      for (const re of SECRET_RES) text = text.replace(re, m => swap('SECRET', m));
      text = text.replace(SECRET_PARAM_RE, (_, k, v) => k + swap('SECRET', v));
      text = text.replace(BEARER_RE, (_, k, v) => k + swap('SECRET', v));
    }
    if (on.iban) text = text.replace(IBAN_RE, m => ibanValid(m) ? swap('IBAN', m) : m);
    if (on.ids) {
      text = text.replace(NI_RE, m => swap('ID', m));
      text = text.replace(SSN_RE, (m, off, all) =>
        /\b(ssn|social security(?: (?:no|number))?)\W{0,3}$/i.test(all.slice(Math.max(0, off - 30), off)) ? swap('ID', m) : m);
    }

    // 3. Arcjet: email, phone, card, IP.
    const entities = Object.entries(ARCJET_TYPES).filter(([, [cat]]) => on[cat]).map(([e]) => e);
    if (entities.length && globalThis.ArcjetRedact) {
      const norm = text.replace(/[()\[\]{}<>,;"'`|]/g, ' ').replace(/\.(?=\s|$)/g, ' ')
        .replace(/(^|\s)(tel|mailto):/gi, (m, a, b) => a + ' '.repeat(b.length + 1));
      const hits = [];
      try {
        await ArcjetRedact.redact(norm, { entities, replace: (e, plain) => { hits.push([e, plain]); return undefined; } });
      } catch (e) { console.warn('redactor: arcjet failed', e); }
      hits.sort((a, b) => b[1].length - a[1].length);
      for (const [e, plain] of hits) {
        if (!plain || HAS_PLACEHOLDER.test(plain)) continue;
        const prefix = ARCJET_TYPES[e][1];
        if (text.includes(plain)) text = text.split(plain).join(swap(prefix, plain));
      }
    }
    if (on.phone) for (const re of PHONE_EXTRA_RES) {
      text = text.replace(re, m => (m.replace(/\D/g, '').length >= 10 && m.replace(/\D/g, '').length <= 11) ? swap('PHONE', m) : m);
    }

    // 4. Names and places (compromise).
    if ((on.names || on.places) && globalThis.nlp) {
      let doc;
      try { doc = nlp(text); } catch { doc = null; }
      const take = (list, prefix, minWords) => {
        const clean = [...new Set(list.map(s => s.replace(/^[^\p{L}]+|[^\p{L}.'-]+$/gu, '').replace(/\.$/, '').trim()))]
          .filter(s => s.length >= 3 && s.length <= 60 && s.split(/\s+/).length >= minWords &&
                       s.split(/\s+/).every(w => /^\p{Lu}/u.test(w)) && !s.includes('⟦'))
          .sort((a, b) => b.length - a.length);
        for (const v of clean) text = text.replace(new RegExp(`(?<![\\p{L}⟦_])${escRe(v)}(?![\\p{L}])`, 'gu'), () => swap(prefix, v));
      };
      if (doc && on.names) take(doc.people().out('array'), 'NAME', 2);
      if (doc && on.places) take(doc.places().out('array'), 'PLACE', 1);
    }
    return { text, found: [...found.values()] };
  }

  /** Redact every string inside a JSON-like value. */
  async redactDeep(value, opts) {
    const found = new Map();
    const walk = async v => {
      if (typeof v === 'string') { const r = await this.redact(v, opts); r.found.forEach(f => found.set(f.ph, f)); return r.text; }
      if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await walk(x)); return out; }
      if (v && typeof v === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = await walk(x); return out; }
      return v;
    };
    const value2 = await walk(value);
    return { value: value2, found: [...found.values()] };
  }

  /** Put real values back for known placeholders. Returns { value, used: [ph] }. */
  unredactDeep(value) {
    const used = new Set();
    const sub = s => s.replace(PLACEHOLDER_RE, ph => { const e = this.byPh.get(ph); if (!e) return ph; used.add(ph); return e.value; });
    const walk = v => typeof v === 'string' ? sub(v)
      : Array.isArray(v) ? v.map(walk)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
      : v;
    const out = walk(value);
    return { value: out, used: [...used] };
  }

  unredact(text) { return this.unredactDeep(text).value; }

  /** Swap placeholders in rendered HTML (text nodes only) for highlighted real values. */
  rehydrate(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (walker.currentNode.nodeValue.includes('⟦')) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      const s = n.nodeValue;
      s.replace(PLACEHOLDER_RE, (ph, _t, _n, off) => {
        const e = this.byPh.get(ph);
        if (!e) return ph;
        frag.append(s.slice(last, off));
        const span = document.createElement('span');
        span.className = 'pii' + (this.shared.has(ph) ? ' shared' : '');
        span.textContent = e.value;
        span.title = `${ph}: hidden from Hermes${this.shared.has(ph) ? ' (now revealed to it)' : ''}`;
        frag.append(span);
        last = off + ph.length;
        return ph;
      });
      if (last) { frag.append(s.slice(last)); n.replaceWith(frag); }
    }
  }
}

globalThis.redactor = new Redactor();
