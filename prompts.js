/* Hermes's interactive prompts from the Outrigger platform as cards: model picker,
   choices, clarify questions, command approvals. Shared by the side panel and the
   full-tab note editor; panel-specific behaviour comes in through `deps`:
     host()                  element a card is appended to by default
     send(chat, kind, id, v) answer a prompt (chat.action)
     defaultChat()           chat id for prompts that carry none
     afterAnswer(chat)?      e.g. mark the turn busy
     focusComposer()?        "Other…" in a clarify card
     onRendered()?           e.g. scroll                                              */
function createPrompts(deps) {
  const promptCards = new Map();  // prompt id -> { card, note, controls, chat }
  let target = null;
  const hostEl = () => target || deps.host();

  function promptCard(m, title, subtitle) {
    const card = document.createElement('div'); card.className = 'confirm hprompt';
    const head = document.createElement('div'); head.className = 'confirm-head'; head.textContent = title;
    card.append(head);
    if (subtitle) { const s = document.createElement('div'); s.className = 'confirm-where'; s.textContent = subtitle; card.append(s); }
    const note = document.createElement('span'); note.className = 'confirm-note';
    const entry = { card, note, controls: [], chat: m.chat_id || deps.defaultChat() };
    promptCards.set(m.id, entry);
    return entry;
  }

  function answerPrompt(m, kind, value, label) {
    const e = promptCards.get(m.id); if (!e) return;
    e.controls.forEach(c => c.disabled = true);
    e.card.classList.add('done'); e.note.textContent = label || 'Sent';
    deps.send(e.chat, kind, m.id, value);
    deps.afterAnswer?.(e.chat);
  }

  function promptResult(m) {
    const e = promptCards.get(m.id); if (!e) return;
    if (m.status !== 'ok') {
      e.note.textContent = { expired: 'No longer active', bad_value: 'Not accepted' }[m.status] || m.status;
      e.card.classList.add('cancelled');
    }
  }

  function button(text, cls, onclick, entry) {
    const b = document.createElement('button'); b.textContent = text; if (cls) b.className = cls;
    b.onclick = onclick; entry.controls.push(b); return b;
  }

  const PROMPT_RENDERERS = {
    'chat.model_picker': m => {
      const cur = m.current || {};
      const e = promptCard(m, 'Choose a model', `Current: ${cur.model || '?'} · ${cur.provider || '?'}`);
      const search = document.createElement('input'); search.className = 'hp-search'; search.placeholder = 'Filter models…';
      const prov = document.createElement('select'); prov.className = 'hp-select';
      const model = document.createElement('select'); model.className = 'hp-select'; model.size = 6;
      const more = document.createElement('div'); more.className = 'confirm-where';
      m.providers.forEach((p, i) => {
        const o = document.createElement('option'); o.value = i;
        o.textContent = p.name + (p.is_current ? ' (current)' : '') + ` — ${p.total_models} model${p.total_models === 1 ? '' : 's'}`;
        prov.append(o);
      });
      // Hermes sends at most 50 models per provider; keep the current one selectable.
      m.providers.forEach(p => { if (p.slug === cur.provider && cur.model && !p.models.includes(cur.model)) p.models.unshift(cur.model); });
      const cur_i = Math.max(0, m.providers.findIndex(p => p.is_current));
      prov.value = cur_i;
      const fill = () => {
        const p = m.providers[+prov.value]; const f = search.value.trim().toLowerCase();
        model.innerHTML = '';
        p.models.filter(x => !f || x.toLowerCase().includes(f)).forEach(x => {
          const o = document.createElement('option'); o.value = x; o.textContent = x + (x === cur.model && p.slug === cur.provider ? '  ✓' : '');
          model.append(o);
        });
        if (model.options.length) model.selectedIndex = 0;
        more.textContent = p.total_models > p.models.length ? `Showing ${p.models.length} of ${p.total_models}; type /model <name> for others.` : '';
      };
      prov.onchange = fill; search.oninput = fill; fill();
      e.controls.push(search, prov, model);
      const row = document.createElement('div'); row.className = 'confirm-row';
      const go = () => { const p = m.providers[+prov.value]; if (!model.value) return;
        answerPrompt(m, 'model', { model: model.value, provider: p.slug }, `Switching to ${model.value}…`); };
      model.ondblclick = go;
      row.append(button('Use this model', 'btn-allow', go, e), e.note);
      e.card.append(search, prov, model, more, row);
      hostEl().append(e.card);
    },
    'chat.choice': m => {
      const [title, ...rest] = String(m.title || 'Choose').split('\n');
      const e = promptCard(m, title, rest.join(' '));
      const row = document.createElement('div'); row.className = 'confirm-row';
      m.options.forEach(o => row.append(button(o.label + (o.is_current ? ' ✓' : ''), o.is_current ? 'btn-grant' : '',
        () => answerPrompt(m, 'choice', o.value, o.label), e)));
      row.append(e.note); e.card.append(row); hostEl().append(e.card);
    },
    'chat.clarify': m => {
      const e = promptCard(m, 'Hermes asks', '');
      const question = document.createElement('div'); question.className = 'hp-question'; question.textContent = m.question;
      e.card.append(question);
      const row = document.createElement('div'); row.className = 'confirm-row';
      if (m.multi) {
        const list = document.createElement('div'); list.className = 'reveal-list';
        const boxes = m.choices.map(c => {
          const l = document.createElement('label'); l.className = 'reveal-item';
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = c;
          const t = document.createElement('span'); t.textContent = c; l.append(cb, t); list.append(l);
          e.controls.push(cb); return cb;
        });
        e.card.append(list);
        row.append(button('Send', 'btn-allow', () => {
          const picked = boxes.filter(b => b.checked).map(b => b.value);
          if (picked.length) answerPrompt(m, 'clarify', picked, picked.join(', '));
        }, e));
      } else {
        m.choices.forEach(c => row.append(button(c, '', () => answerPrompt(m, 'clarify', c, c), e)));
      }
      row.append(button('Other…', 'btn-deny', () => { answerPrompt(m, 'clarify', '__other__', 'Type your answer below'); deps.focusComposer?.(); }, e), e.note);
      e.card.append(row); hostEl().append(e.card);
    },
    'chat.approval': m => {
      const e = promptCard(m, 'Hermes wants to run a command', m.description || '');
      e.card.classList.add('flagged');
      const pre = document.createElement('pre'); pre.className = 'confirm-args'; pre.textContent = m.command;
      e.card.append(pre);
      const row = document.createElement('div'); row.className = 'confirm-row';
      m.actions.forEach(a => row.append(button(a.label, a.style === 'primary' ? 'btn-allow' : a.style === 'danger' ? 'btn-deny' : '',
        () => answerPrompt(m, 'approval', a.choice, a.label), e)));
      row.append(e.note); e.card.append(row); hostEl().append(e.card);
    },
  };

  return {
    renderers: PROMPT_RENDERERS,
    handles: type => !!PROMPT_RENDERERS[type],
    render(m, el) {
      target = el || null;
      try { PROMPT_RENDERERS[m.type](m); } catch (err) { console.warn('prompt render failed', err); }
      target = null;
      deps.onRendered?.();
    },
    result: promptResult,
  };
}
