// Minimal, dependency-free Markdown -> safe HTML. All input is HTML-escaped first;
// only a fixed set of tags is produced, and links are restricted to http(s)/mailto.
(function () {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    // s is already escaped. Protect inline code first.
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+[^\s<).,;:!?'"])/g,
      (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  }

  function table(rows) {
    const cells = r => r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => inline(c.trim()));
    const head = cells(rows[0]);
    let h = '<table><thead><tr>' + head.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of rows.slice(2)) h += '<tr>' + cells(r).map(c => `<td>${c}</td>`).join('') + '</tr>';
    return h + '</tbody></table>';
  }

  function render(src) {
    const lines = esc(src.replace(/\r\n?/g, '\n')).split('\n');
    let out = '', i = 0, para = [];
    const flush = () => { if (para.length) { out += '<p>' + inline(para.join('<br>')) + '</p>'; para = []; } };

    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^\s*```\s*([\w+#.-]*)/))) {           // fenced code (may be unterminated while streaming)
        flush(); const lang = m[1]; const buf = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out += `<div class="code"><div class="code-head"><span>${lang || 'code'}</span><button data-copy>Copy</button></div><pre><code>${buf.join('\n')}</code></pre></div>`;
        continue;
      }
      if (/^\s*$/.test(l)) { flush(); i++; continue; }
      if ((m = l.match(/^(#{1,4})\s+(.*)$/))) { flush(); const n = m[1].length; out += `<h${n}>${inline(m[2])}</h${n}>`; i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out += '<hr>'; i++; continue; }
      if (/^\s*&gt;/.test(l)) {
        flush(); const buf = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) buf.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
        out += '<blockquote>' + render.inner(buf.join('\n')) + '</blockquote>'; continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flush(); const buf = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
        out += table(buf); continue;
      }
      if ((m = l.match(/^\s*([-*+]|\d+[.)])\s+/))) {
        flush(); const ordered = /\d/.test(m[1]); const tag = ordered ? 'ol' : 'ul';
        const start = ordered ? parseInt(m[1], 10) : 1;
        out += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`;
        let item = null;
        while (i < lines.length) {
          const li = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
          if (li && (/\d/.test(li[1]) === ordered)) { if (item !== null) out += `<li>${inline(item)}</li>`; item = li[2]; i++; }
          else if (item !== null && /^\s{2,}\S/.test(lines[i])) { item += '<br>' + lines[i].trim(); i++; }
          else break;
        }
        if (item !== null) out += `<li>${inline(item)}</li>`;
        out += `</${tag}>`; continue;
      }
      para.push(l); i++;
    }
    flush();
    return out;
  }
  // Blockquote bodies are already escaped: unescape, then render (which re-escapes).
  render.inner = s => render(s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));

  window.renderMarkdown = render;
})();
