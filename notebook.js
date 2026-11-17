/* Notebook mode (hermes-outrigger docs/notebook.md): edit a Markdown note that lives on
   the Hermes host. Edits autosave against the note's version; a line starting with `//`
   (outside code fences) is sent to Hermes when you press Enter on it. Hermes removes
   it, works on the note while the editor is locked, and the editor unlocks with a
   summary, changed lines highlighted, and Undo. Changes made elsewhere (Obsidian,
   sync, another client) are merged in. Uses vendor/editor.js (CodeMirror 6 +
   diff-match-patch, global HermesEditor). */

const NB = (() => {
  const E = HermesEditor;
  const dmp = new E.diff_match_patch();
  const $ = id => document.getElementById(id);

  const st = {
    doc: null,            // { doc_id, root, path }
    version: '',          // server version of the text we last synced
    base: '',             // that text (for merging)
    view: null,
    applying: false,      // setting text from the server: not a user edit
    saveTimer: 0, saving: null,
    locked: false, lock: null,
    noteChat: '',         // the note's chat id on the Outrigger platform
    beforeHermes: '',     // text right after the // line was removed (for the change highlight)
    summary: '',
  };

  /* ---------- editor ---------- */
  const editable = new E.Compartment();
  const setChanged = E.StateEffect.define();
  const changedField = E.StateField.define({
    create: () => E.Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setChanged)) deco = e.value;
      return deco;
    },
    provide: f => E.EditorView.decorations.from(f),
  });

  // Lines starting with // (outside ``` fences) are commands for Hermes.
  function commandLines(view) {
    const b = new E.RangeSetBuilder();
    let fenced = false;
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i);
      if (/^\s*(```|~~~)/.test(line.text)) { fenced = !fenced; continue; }
      if (!fenced && /^\s*\/\//.test(line.text)) b.add(line.from, line.from, E.Decoration.line({ class: 'cm-hermes-cmd' }));
    }
    return b.finish();
  }
  const commandStyle = E.ViewPlugin.fromClass(class {
    constructor(v) { this.decorations = commandLines(v); }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = commandLines(u.view); }
  }, { decorations: v => v.decorations });

  function inFence(state, lineNo) {
    let fenced = false;
    for (let i = 1; i < lineNo; i++) if (/^\s*(```|~~~)/.test(state.doc.line(i).text)) fenced = !fenced;
    return fenced;
  }

  function onEnter(view) {
    if (st.locked || !st.doc) return false;
    const head = view.state.selection.main;
    const line = view.state.doc.lineAt(head.head);
    // Only a // line you have just finished (cursor at its end, nothing selected) is sent.
    // Enter anywhere else splits the line as usual, so typing // in front of existing text
    // never sends that text away.
    if (!head.empty || head.head !== line.to) return false;
    const m = line.text.match(/^\s*\/\/(.*\S.*)$/);
    if (!m || inFence(view.state, line.number)) return false;
    sendCommand(line.number, m[1].trim());
    return true;  // no newline: the line is going to Hermes
  }

  function makeView() {
    st.view = new E.EditorView({
      parent: $('noteEditor'),
      state: E.EditorState.create({ doc: '', extensions: [
        E.keymap.of([{ key: 'Enter', run: onEnter }, { key: 'Mod-/', run: () => { askSelection(); return true; } }]),
        E.history(), E.drawSelection(), E.highlightActiveLine(), E.search(),
        E.keymap.of([...E.defaultKeymap, ...E.historyKeymap, ...E.searchKeymap, E.indentWithTab]),
        E.markdown(), E.syntaxHighlighting(E.defaultHighlightStyle, { fallback: true }),
        E.EditorView.lineWrapping, editable.of(E.EditorView.editable.of(true)),
        E.placeholder('Type here. Start a line with // to ask Hermes, e.g. //correct my spelling'),
        commandStyle, changedField,
        E.EditorView.updateListener.of(u => {
          if (u.docChanged && !st.applying) { clearHighlight(); scheduleSave(); }
          if (u.docChanged && previewOn()) renderPreview();
          if (u.selectionSet || u.docChanged) $('noteAsk').disabled = st.locked || st.view.state.selection.main.empty;
        }),
      ] }),
    });
  }

  const text = () => st.view.state.doc.toString();
  function setText(t) {
    if (t === text()) return;
    st.applying = true;
    const sel = st.view.state.selection.main.head;
    st.view.dispatch({ changes: { from: 0, to: st.view.state.doc.length, insert: t },
                       selection: { anchor: Math.min(sel, t.length) } });
    st.applying = false;
  }
  function setEditable(on) { st.view.dispatch({ effects: editable.reconfigure(E.EditorView.editable.of(on)) }); }

  /* ---------- presence (N4) ---------- */
  const mine = w => !!w && w.client_id === outrigger.clientId;
  function renderPresence(viewers) {
    const el = $('notePresence'); el.innerHTML = '';
    const others = viewers.filter(v => !mine(v));
    for (const v of others.slice(0, 5)) {
      const b = document.createElement('span'); b.className = 'presence-dot';
      b.textContent = (v.name || v.user || '?').trim().slice(0, 1).toUpperCase();
      b.title = `${v.name || v.user} — ${v.label}`;
      el.append(b);
    }
    if (others.length > 5) { const more = document.createElement('span'); more.className = 'presence-more'; more.textContent = '+' + (others.length - 5); el.append(more); }
    el.title = others.length ? `Also open: ${others.map(v => `${v.name || v.user} (${v.label})`).join(', ')}` : '';
  }

  /* ---------- status ---------- */
  function status(s, cls = '') { const el = $('noteStatus'); el.textContent = s; el.className = 'note-status ' + cls; }
  const dirty = () => st.doc && text() !== st.base;

  /* ---------- saving ---------- */
  function scheduleSave() {
    if (!st.doc || st.locked) return;
    status('Unsaved', 'warn');
    clearTimeout(st.saveTimer);
    st.saveTimer = setTimeout(() => save().catch(() => {}), 800);
  }
  function save() {
    clearTimeout(st.saveTimer);
    if (!st.doc || !dirty()) return Promise.resolve();
    if (st.saving) return st.saving.promise.then(save);
    const sent = text();
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    st.saving = { sent, resolve, reject, promise };
    status('Saving…');
    outrigger._send({ type: 'doc.update', doc_id: st.doc.doc_id, base_version: st.version, text: sent });
    return promise;
  }

  /* ---------- // commands ---------- */
  async function sendCommand(lineNo, instruction) {
    try { await save(); } catch { return; }
    status('Sending to Hermes…');
    outrigger._send({ type: 'doc.command', doc_id: st.doc.doc_id, base_version: st.version, line: lineNo, instruction });
  }

  /* ---------- a command on the selected lines (no // line) ---------- */
  function selectedLines() {
    const s = st.view.state.selection.main;
    if (s.empty) return null;
    const doc = st.view.state.doc;
    let a = doc.lineAt(s.from).number, b = doc.lineAt(s.to).number;
    if (b > a && s.to === doc.line(b).from) b -= 1;  // a selection ending at a line start stops above it
    return { from_line: a, to_line: b };
  }
  function askSelection() {
    if (st.locked || !st.doc) return;
    const sel = selectedLines();
    if (!sel) { status('Select some text first', 'warn'); return; }
    const box = $('noteAskBox');
    $('noteAskWhat').textContent = sel.from_line === sel.to_line ? `Line ${sel.from_line}` : `Lines ${sel.from_line}–${sel.to_line}`;
    box.hidden = false; box.dataset.sel = JSON.stringify(sel);
    const inp = $('noteAskInput'); inp.value = ''; inp.focus();
  }
  async function sendSelectionCommand() {
    const box = $('noteAskBox'), instruction = $('noteAskInput').value.trim();
    if (!instruction) return;
    const sel = JSON.parse(box.dataset.sel || 'null');
    box.hidden = true;
    try { await save(); } catch { return; }
    status('Sending to Hermes…');
    outrigger._send({ type: 'doc.command', doc_id: st.doc.doc_id, base_version: st.version, selection: sel, instruction });
  }

  /* ---------- preview ---------- */
  const previewOn = () => !$('notePreview').hidden;
  function renderPreview() { $('notePreview').innerHTML = renderMarkdown(text()); }
  function togglePreview() {
    const on = !previewOn();
    $('notePreview').hidden = !on; $('noteEditor').hidden = on;
    $('notePreviewBtn').classList.toggle('active', on);
    $('notePreviewBtn').textContent = on ? 'Edit' : 'Preview';
    if (on) renderPreview(); else st.view.focus();
  }

  function showLock(lock) {
    st.locked = true; st.lock = lock; st.summary = '';
    setEditable(false); $('noteAsk').disabled = true; $('noteAskBox').hidden = true;
    $('notePrompts').innerHTML = '';  // cards from an earlier command
    $('noteResult').hidden = true;
    $('noteLockText').textContent = lock.instruction || '';
    const others = lock.who && !mine(lock.who);
    $('noteLockWho').textContent = others ? ` ${lock.who.name}'s request:` : ':';
    $('noteStop').hidden = !!others;  // only the person who asked can stop their command
    $('noteLock').hidden = false;
    status('Hermes is working…', 'busy');
    if (lock.chat_id) st.noteChat = lock.chat_id;
  }

  function endLock(m) {
    st.locked = false;
    setEditable(true);
    $('noteLock').hidden = true;
    status(m.notice ? m.notice : 'Saved', m.notice ? 'warn' : 'ok');
    highlightChanges(st.beforeHermes, text());
    const res = $('noteResult');
    $('noteResultText').textContent = st.summary || (m.notice || 'Hermes finished.');
    res.dataset.snapshot = m.snapshot || '';
    res.hidden = false;
  }

  function highlightChanges(before, after) {
    if (!before) return;
    const a = dmp.diff_linesToChars_(before, after);
    const diffs = dmp.diff_main(a.chars1, a.chars2, false);
    dmp.diff_charsToLines_(diffs, a.lineArray);
    const b = new E.RangeSetBuilder();
    let pos = 0;
    for (const [op, chunk] of diffs) {
      if (op === 1) {
        const doc = st.view.state.doc;
        const start = doc.lineAt(Math.min(pos, doc.length)).number, end = doc.lineAt(Math.min(pos + chunk.length - 1, doc.length)).number;
        for (let i = start; i <= end; i++) b.add(doc.line(i).from, doc.line(i).from, E.Decoration.line({ class: 'cm-hermes-changed' }));
      }
      if (op !== -1) pos += chunk.length;
    }
    st.view.dispatch({ effects: setChanged.of(b.finish()) });
  }
  function clearHighlight() { if (st.view.state.field(changedField).size) st.view.dispatch({ effects: setChanged.of(E.Decoration.none) }); }

  /* ---------- outside changes: merge ---------- */
  function takeRemote(remoteText, remoteVersion) {
    if (!dirty()) {
      setText(remoteText); st.base = remoteText; st.version = remoteVersion; status('Updated from disk', 'ok');
      return;
    }
    // 3-way: apply my edits (base -> mine) on top of theirs.
    const patches = dmp.patch_make(st.base, text());
    const [merged, ok] = dmp.patch_apply(patches, remoteText);
    if (ok.every(Boolean)) {
      st.base = remoteText; st.version = remoteVersion; setText(merged); scheduleSave();
      status('Merged with changes made elsewhere', 'ok');
    } else {
      showConflict(remoteText, remoteVersion);
    }
  }
  function showConflict(remoteText, remoteVersion) {
    status('Conflict', 'bad');
    const bar = $('noteConflict'); bar.hidden = false;
    $('noteTheirs').onclick = () => { bar.hidden = true; setText(remoteText); st.base = remoteText; st.version = remoteVersion; status('Took the other version', 'ok'); };
    $('noteMine').onclick = () => { bar.hidden = true; st.base = remoteText; st.version = remoteVersion; scheduleSave(); };
  }

  /* ---------- frames from the plugin ---------- */
  function onFrame(m) {
    if (m.type === 'doc.list') return renderList(m);
    if (!st.doc || m.doc_id !== st.doc.doc_id) return;
    switch (m.type) {
      case 'doc.content':
        if (m.by === 'command') st.beforeHermes = m.text;
        setText(m.text); st.base = m.text; st.version = m.version;
        if (m.locked && !st.locked) showLock(m.lock || {});
        if (!m.locked && m.by !== 'hermes') status('Saved', 'ok');
        if (m.by === 'undo') { clearHighlight(); $('noteResult').hidden = true; status('Undone', 'ok'); }
        break;
      case 'doc.saved':
        st.version = m.version;
        if (st.saving) { st.base = st.saving.sent; st.saving.resolve(); st.saving = null; }
        status(dirty() ? 'Unsaved' : 'Saved', dirty() ? 'warn' : 'ok');
        if (dirty()) scheduleSave();
        break;
      case 'doc.changed':
        takeRemote(m.text, m.version);
        if (m.who && !mine(m.who)) status(`${m.who.name} edited`, 'ok');
        break;
      case 'doc.presence':
        renderPresence(m.viewers || []);
        break;
      case 'doc.lock':
        if (m.locked) showLock(m); else endLock(m);
        break;
      case 'doc.error':
        if (st.saving) { const s = st.saving; st.saving = null; s.reject(m); }
        if (m.code === 'conflict' && typeof m.text === 'string') takeRemote(m.text, m.version);
        else status(m.message || m.code, 'bad');
        break;
    }
  }

  // Replies in the note's chat (Hermes's one-line summary) and its status lines.
  function onChat(m) {
    if (!st.noteChat || m.chat_id !== st.noteChat) return false;
    if ((m.type === 'chat.message' || m.type === 'chat.edit') && m.text && !/^\p{Extended_Pictographic}/u.test(m.text.trim())) {
      st.summary = m.text.trim();
      if (!st.locked) $('noteResultText').textContent = st.summary;
    }
    return true;
  }

  /* ---------- picker ---------- */
  let pickTimer = 0;
  function openPicker(query = '') {
    $('notePicker').hidden = false;
    const inp = $('notePickQuery'); inp.value = query; inp.focus();
    requestList(query);
  }
  function requestList(q) { outrigger._send({ type: 'doc.list', query: q, limit: 60 }); }
  function renderList(m) {
    const ul = $('notePickList'); ul.innerHTML = '';
    if (!m.notes.length) { const li = document.createElement('li'); li.className = 'empty-row'; li.textContent = 'No notes match'; ul.append(li); }
    for (const n of m.notes) {
      const li = document.createElement('li');
      const t = document.createElement('div'); t.className = 'pick-title'; t.textContent = n.title;
      const p = document.createElement('div'); p.className = 'pick-path'; p.textContent = `${n.root} · ${n.path}`;
      li.append(t, p);
      li.onclick = () => open(n.root, n.path);
      ul.append(li);
    }
  }

  function open(root, path) {
    if (st.doc) { save().catch(() => {}); outrigger._send({ type: 'doc.close', doc_id: st.doc.doc_id }); }
    st.doc = { doc_id: `${root}:${path}`, root, path };
    st.base = ''; st.version = ''; st.locked = false; st.noteChat = '';
    $('notePicker').hidden = true; $('noteResult').hidden = true; $('noteConflict').hidden = true;
    $('notePath').textContent = path; $('notePath').title = `${root}: ${path}`;
    status('Opening…');
    setText('');
    outrigger._send({ type: 'doc.open', root, path });
    remember();
  }

  async function remember() {
    try { const w = await chrome.windows.getCurrent(); await chrome.storage.session.set({ ['note-' + w.id]: st.doc }); } catch {}
  }

  function init() {
    makeView();
    $('noteOpen').onclick = () => openPicker('');
    $('noteAsk').onclick = askSelection;
    $('noteAskSend').onclick = sendSelectionCommand;
    $('noteAskCancel').onclick = () => { $('noteAskBox').hidden = true; st.view.focus(); };
    $('noteAskInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); sendSelectionCommand(); }
      if (e.key === 'Escape') { $('noteAskBox').hidden = true; st.view.focus(); } };
    $('notePreviewBtn').onclick = togglePreview;
    const tabBtn = $('noteTab');
    if (tabBtn) tabBtn.onclick = () => { if (!st.doc) return; save().catch(() => {});
      chrome.tabs.create({ url: chrome.runtime.getURL(`notebook.html?root=${encodeURIComponent(st.doc.root)}&path=${encodeURIComponent(st.doc.path)}`) }); };
    $('notePickQuery').oninput = e => { clearTimeout(pickTimer); pickTimer = setTimeout(() => requestList(e.target.value), 200); };
    $('notePickQuery').onkeydown = e => { if (e.key === 'Escape') $('notePicker').hidden = true;
      if (e.key === 'Enter') $('notePickList').querySelector('li:not(.empty-row)')?.click(); };
    $('noteStop').onclick = () => { if (st.noteChat) outrigger.chatStop(st.noteChat); };
    $('noteUndo').onclick = () => { const s = $('noteResult').dataset.snapshot; if (s) outrigger._send({ type: 'doc.undo', doc_id: st.doc.doc_id, snapshot: s }); };
    $('noteKeep').onclick = () => { $('noteResult').hidden = true; clearHighlight(); };
  }

  // After (re)connecting: reopen the note that was open in this window.
  async function reattach() {
    if (st.doc) { outrigger._send({ type: 'doc.open', root: st.doc.root, path: st.doc.path }); return; }
    try {
      const w = await chrome.windows.getCurrent();
      const d = (await chrome.storage.session.get('note-' + w.id))['note-' + w.id];
      if (d) open(d.root, d.path);
    } catch {}
  }

  const isNoteChat = id => !!st.noteChat && id === st.noteChat;
  return { init, onFrame, onChat, openPicker, open, reattach, isNoteChat, get active() { return !!st.doc; }, save };
})();
