// Markdown -> safe HTML for replies: marked (GFM) + highlight.js, sanitized by DOMPurify.
// Raw HTML in the source is shown as text, not rendered; links open in a new tab;
// images load only over https, without a referrer.
(function () {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const md = new marked.Marked({ gfm: true, breaks: true });
  md.use({
    renderer: {
      // Same markup as before, so the panel's copy button keeps working.
      code({ text, lang }) {
        const language = ((lang || '').match(/^[\w+#.-]+/) || [''])[0].toLowerCase();
        let body;
        if (language && window.hljs && hljs.getLanguage(language)) {
          try { body = hljs.highlight(text, { language, ignoreIllegals: true }).value; } catch { body = esc(text); }
        } else {
          body = esc(text);  // no auto-detection: slow, and often wrong on short snippets
        }
        return `<div class="code"><div class="code-head"><span>${esc(language || 'code')}</span>` +
               `<button data-copy>Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`;
      },
      // Model output can quote page content; never let it inject markup.
      html({ text }) { return esc(text); },
    },
  });

  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:)/i.test(href)) { node.removeAttribute('href'); return; }
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (!/^https:/i.test(src)) { node.remove(); return; }
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
    } else if (node.tagName === 'INPUT') {
      // GFM task-list boxes only.
      if (node.getAttribute('type') !== 'checkbox') { node.remove(); return; }
      node.setAttribute('disabled', '');
    }
  });

  const PURIFY = {
    FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'iframe', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style'],
  };

  window.renderMarkdown = src => {
    try {
      return DOMPurify.sanitize(md.parse(String(src).replace(/\r\n?/g, '\n')), PURIFY);
    } catch {
      return '<p>' + esc(src).replace(/\n/g, '<br>') + '</p>';
    }
  };
})();
