// Injected into pages (in the extension's isolated world) by browser-tools.js.
// Element refs live here, out of the page's reach: the page cannot read, list or
// forge them. Safe to inject repeatedly; state persists for the page's lifetime.
(() => {
  if (globalThis.__hermes) return;

  /* ---------- refs ---------- */
  const refs = new Map();      // "e12" -> WeakRef(element)
  const ids = new WeakMap();   // element -> "e12" (same element keeps its ref)
  let next = 1;
  const refOf = el => {
    let r = ids.get(el);
    if (!r) { r = 'e' + next++; ids.set(el, r); }
    refs.set(r, new WeakRef(el));
    return r;
  };

  // querySelector that also looks inside open shadow roots.
  function deepQuery(selector, root = document) {
    const hit = root.querySelector(selector);
    if (hit) return hit;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const h = deepQuery(selector, el.shadowRoot); if (h) return h; }
    }
    return null;
  }

  function resolve({ ref, selector } = {}) {
    if (ref) {
      const el = refs.get(ref)?.deref();
      if (!el || !el.isConnected) throw new Error(`Ref ${ref} is stale or unknown: take a new snapshot`);
      return el;
    }
    if (selector) {
      let el;
      try { el = deepQuery(selector); } catch { throw new Error(`Invalid selector: ${selector}`); }
      if (!el) throw new Error(`No element matches ${selector}`);
      return el;
    }
    throw new Error('Pass ref (from snapshot) or selector');
  }

  /* ---------- roles and names ---------- */
  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
    image: 'button', range: 'slider', search: 'searchbox', file: 'file', color: 'button' };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'svg', 'SVG', 'HEAD', 'META', 'LINK']);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const t = el.tagName;
    switch (t) {
      case 'A': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'SELECT': return el.multiple ? 'listbox' : 'combobox';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const ty = (el.getAttribute('type') || 'text').toLowerCase();
        return ty === 'hidden' ? null : (INPUT_ROLES[ty] || 'textbox');
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'IMG': return el.alt ? 'img' : null;
      case 'DIALOG': return 'dialog';
    }
    if (el.isContentEditable && el.parentElement && !el.parentElement.isContentEditable) return 'textbox';
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return 'focusable';
    return null;
  }

  const squash = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode();
      const t = by.split(/\s+/).map(id => root.getElementById?.(id)?.textContent || '').join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) return [...el.labels].map(l => l.innerText).join(' ');
    if (el.tagName === 'IMG') return el.alt;
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return el.value;
    const txt = el.innerText || el.textContent;
    if (txt && txt.trim()) return txt;
    return el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
  }

  function hidden(el) {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.checkVisibility) return !el.checkVisibility({ checkVisibilityCSS: true }) && getComputedStyle(el).display !== 'contents';
    return false;
  }

  const ownText = el => {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.textContent;
    return squash(s, 160);
  };

  // Mark values of personal-data fields so the sidebar's redactor can replace them
  // even when no text pattern would (names, addresses). See redactor.js.
  const AUTOCOMPLETE_PII = [
    [/^(email)$/, 'email'], [/^tel/, 'phone'],
    [/^(name|given-name|family-name|additional-name|nickname|honorific-\w+|cc-name|username)$/, 'name'],
    [/^(street-address|address-line\d|address-level\d)$/, 'address'], [/^postal-code$/, 'postcode'],
    [/^cc-number$/, 'card'], [/^(cc-csc|cc-exp.*|one-time-code|current-password|new-password)$/, 'secret'],
    [/^bday/, 'dob'],
  ];
  function piiMark(el, value) {
    if (!value) return value;
    const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    let kind = null;
    for (const tok of tokens) for (const [re, k] of AUTOCOMPLETE_PII) if (!kind && re.test(tok)) kind = k;
    if (!kind && el.type === 'email') kind = 'email';
    if (!kind && el.type === 'tel') kind = 'phone';
    return kind ? `⟪pii:${kind}:${value.replace(/[⟪⟫]/g, '')}⟫` : value;
  }

  function describe(el, role) {
    const parts = [`${role} "${squash(nameOf(el), 100)}"`, `[${refOf(el)}]`];
    if (role === 'heading') parts.push('level=' + el.tagName[1]);
    if (role === 'link') {
      try {
        const u = new URL(el.href, location.href);
        parts.push('-> ' + (u.origin === location.origin ? u.pathname + u.search : u.href).slice(0, 100));
      } catch {}
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      if (el.type === 'password') parts.push('value=•••');
      else if (el.tagName === 'SELECT') parts.push(`value="${squash(el.selectedOptions?.[0]?.text, 60)}"`);
      else if ('value' in el) parts.push(`value="${piiMark(el, squash(el.value, 60))}"`);
    }
    if ((role === 'checkbox' || role === 'radio' || role === 'switch') && (el.checked || el.getAttribute('aria-checked') === 'true')) parts.push('checked');
    const exp = el.getAttribute('aria-expanded'); if (exp) parts.push('expanded=' + exp);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) parts.push('offscreen');
    return parts.join(' ');
  }

  /* ---------- snapshot ---------- */
  function snapshot({ ref, selector, text = false, max_items = 300 } = {}) {
    const root = (ref || selector) ? resolve({ ref, selector }) : document.documentElement;
    const lines = [];
    let total = 0;
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || SKIP.has(el.tagName) || (el !== root && hidden(el))) continue;
      const role = roleOf(el);
      if (role) {
        total++;
        if (lines.length < max_items) lines.push(describe(el, role));
      } else if (text) {
        const t = ownText(el);
        if (t.length >= 2) { total++; if (lines.length < max_items) lines.push(`text "${t}"`); }
      }
      // Don't list the insides of a control (its name already covers them).
      if (role && role !== 'dialog' && role !== 'focusable' && role !== 'heading') continue;
      const kids = [];
      if (el.shadowRoot) kids.push(...el.shadowRoot.children);
      kids.push(...el.children);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    const se = document.scrollingElement || document.documentElement;
    const screens = Math.max(1, Math.round(se.scrollHeight / innerHeight));
    const pct = se.scrollHeight > innerHeight ? Math.round(100 * se.scrollTop / (se.scrollHeight - innerHeight)) : 0;
    const head = `Page: "${squash(document.title, 120)}" ${location.href.slice(0, 200)} ` +
                 `(scroll ${pct}%, ${screens} screen${screens === 1 ? '' : 's'})`;
    const more = total > lines.length ? `\n… ${total - lines.length} more not shown: narrow with ref/selector or scroll` : '';
    return head + '\n' + lines.join('\n') + more;
  }

  /* ---------- actions ---------- */
  function click(target) {
    const el = resolve(target);
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { clicked: describe(el, roleOf(el) || el.tagName.toLowerCase()) };
  }

  function setValue(el, value) {
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      // The prototype setter, so frameworks that track value (React) see the change.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
      const set = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (!set) throw new Error(`${el.tagName.toLowerCase()} is not fillable`);
      if (el instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(el.type)) {
        el.checked = /^(true|1|on|yes|checked)$/i.test(String(value));
      } else {
        set.call(el, value);
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(target, value) {
    const el = resolve(target);
    setValue(el, value);
    return { filled: describe(el, roleOf(el) || 'textbox') };
  }

  function fillForm(fields, submit) {
    // Resolve everything first, so a bad ref fills nothing.
    const els = fields.map(f => resolve(f));
    const submitEl = submit ? resolve(submit) : null;
    els.forEach((el, i) => setValue(el, fields[i].value));
    const out = { filled: els.map(el => describe(el, roleOf(el) || 'textbox')) };
    if (submitEl) { submitEl.scrollIntoView({ block: 'center' }); submitEl.click(); out.submitted = describe(submitEl, roleOf(submitEl) || 'button'); }
    return out;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // The element that actually scrolls: the document, or (SPAs) the largest scrollable box.
  function scroller() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight > se.clientHeight + 20) return se;
    let best = se, area = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      const a = el.clientWidth * el.clientHeight;
      if (a > area) { area = a; best = el; }
    }
    return best;
  }

  async function scroll({ to, ref, selector, by, wait_ms = 800 } = {}) {
    const sc = scroller();
    const before = sc.scrollHeight;
    if (ref || selector) resolve({ ref, selector }).scrollIntoView({ block: 'center' });
    else if (to === 'top') sc.scrollTo(0, 0);
    else if (to === 'bottom') sc.scrollTo(0, sc.scrollHeight);
    else sc.scrollBy(0, by || Math.round(sc.clientHeight * 0.9));
    await sleep(Math.min(Math.max(wait_ms, 0), 5000));  // let lazy content load
    const after = sc.scrollHeight;
    return {
      scroll_y: Math.round(sc.scrollTop), page_height: after, grew: after > before,
      at_bottom: sc.scrollTop + sc.clientHeight >= after - 4,
    };
  }

  // Text of the document including open shadow roots.
  function deepText(root = document.body) {
    let out = '';
    const visit = node => {
      if (node.nodeType === 3) { out += node.textContent; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      if (node.nodeType === 1 && SKIP.has(node.tagName)) return;
      if (node.shadowRoot) visit(node.shadowRoot);
      for (const c of node.childNodes) visit(c);
    };
    if (root) visit(root);
    return out;
  }

  async function waitFor({ text, ref, selector, gone = false, timeout_ms = 10000 } = {}) {
    if (!text && !ref && !selector) throw new Error('Pass text, ref or selector');
    const limit = Math.min(Math.max(timeout_ms, 100), 15000);
    const t0 = performance.now();
    const present = () => {
      if (text) return deepText().toLowerCase().includes(String(text).toLowerCase());
      try { const el = resolve({ ref, selector }); return !hidden(el); } catch { return false; }
    };
    while (performance.now() - t0 < limit) {
      if (present() !== gone) return { met: true, waited_ms: Math.round(performance.now() - t0) };
      await sleep(250);
    }
    return { met: false, waited_ms: limit };
  }

  /* ---------- same-site fetch ---------- */
  const BLOCK = 'ADDRESS,ARTICLE,ASIDE,BLOCKQUOTE,DD,DIV,DL,DT,FIELDSET,FIGCAPTION,FIGURE,FOOTER,FORM,H1,H2,H3,H4,H5,H6,HEADER,HR,LI,MAIN,NAV,OL,P,PRE,SECTION,TABLE,TR,UL,BR';

  function htmlToText(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    const title = d.title;
    d.querySelectorAll('script,style,noscript,svg,iframe,head').forEach(n => n.remove());
    d.querySelectorAll(BLOCK).forEach(n => n.append('\n'));
    const body = (d.body ? d.body.textContent : '').replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n[\s]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return (title ? title.trim() + '\n\n' : '') + body;
  }

  async function fetchAsUser({ url, max_chars = 20000 }) {
    let u;
    try { u = new URL(url, location.href); } catch { throw new Error('Not a valid URL'); }
    if (u.origin !== location.origin) throw new Error(`Only URLs on ${location.origin} (the tab's site) can be fetched`);
    let r;
    try { r = await fetch(u.href, { method: 'GET', credentials: 'include', redirect: 'follow' }); }
    catch { throw new Error('Request failed: network error, or redirected to another site'); }
    if (new URL(r.url).origin !== location.origin) throw new Error('The request was redirected to another site; not returned');
    const type = r.headers.get('content-type') || '';
    let body = await r.text();
    if (/json/i.test(type)) { try { body = JSON.stringify(JSON.parse(body)); } catch {} }
    else if (/html/i.test(type)) body = htmlToText(body);
    const max = Math.min(Math.max(max_chars, 200), 60000);
    return { status: r.status, url: r.url, content_type: type.split(';')[0], truncated: body.length > max, body: body.slice(0, max) };
  }

  // What refs/selectors point at, for the approval card.
  function labels(targets) {
    return targets.map(t => {
      try { const el = resolve(t); return describe(el, roleOf(el) || el.tagName.toLowerCase()); }
      catch (e) { return `(${e.message})`; }
    });
  }

  /* ---------- highlight: point at something without changing the page ---------- */
  let hlTimer = 0;
  function clearHighlight() {
    clearTimeout(hlTimer);
    document.getElementById('__hermes_hl')?.remove();
    try { CSS.highlights.delete('hermes'); } catch {}
  }

  function findText(needle) {
    const want = String(needle).toLowerCase();
    const roots = [document.body];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = walker.currentNode; n; n = walker.nextNode()) {
        if (n.nodeType === 1) { if (n.shadowRoot) roots.push(n.shadowRoot); continue; }
        const at = n.textContent.toLowerCase().indexOf(want);
        if (at >= 0 && !SKIP.has(n.parentElement?.tagName)) {
          const r = document.createRange(); r.setStart(n, at); r.setEnd(n, Math.min(n.textContent.length, at + want.length));
          return r;
        }
      }
    }
    return null;
  }

  function highlight({ ref, selector, text, seconds = 6 } = {}) {
    clearHighlight();
    const ms = Math.min(Math.max(seconds, 1), 30) * 1000;
    if (text) {
      const range = findText(text);
      if (!range) throw new Error(`Text not found: ${String(text).slice(0, 80)}`);
      range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (!document.getElementById('__hermes_hl_style')) {
        const st = document.createElement('style'); st.id = '__hermes_hl_style';
        st.textContent = '::highlight(hermes){background:#ffd54a;color:#111}';
        document.documentElement.append(st);
      }
      CSS.highlights.set('hermes', new Highlight(range));
      hlTimer = setTimeout(clearHighlight, ms);
      return { highlighted: 'text', text: range.toString().slice(0, 120) };
    }
    const el = resolve({ ref, selector });
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const box = document.createElement('div'); box.id = '__hermes_hl';
    const place = () => { const r = el.getBoundingClientRect();
      Object.assign(box.style, { position: 'fixed', left: r.left - 4 + 'px', top: r.top - 4 + 'px', width: r.width + 8 + 'px',
        height: r.height + 8 + 'px', border: '3px solid #e0805a', borderRadius: '8px', boxShadow: '0 0 0 4000px rgba(0,0,0,.12)',
        zIndex: 2147483647, pointerEvents: 'none', transition: 'all .15s' }); };
    place(); document.documentElement.append(box);
    const follow = setInterval(() => box.isConnected ? place() : clearInterval(follow), 100);
    hlTimer = setTimeout(() => { clearInterval(follow); clearHighlight(); }, ms);
    return { highlighted: describe(el, roleOf(el) || el.tagName.toLowerCase()) };
  }

  globalThis.__hermes = { snapshot, click, fill, fillForm, scroll, waitFor, fetchAsUser, labels, highlight };
})();
