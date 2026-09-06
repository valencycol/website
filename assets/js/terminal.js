/* ============================================================
   Terminal — command router, output stream, modal manager

   Modals do not re-render their contents. Each command's panel
   already exists in #panels; opening one MOVES the node into the
   modal stage and closing moves it back. That keeps every listener
   the feed and game modules bound at boot alive — nothing is
   cloned, nothing is re-wired.
   ============================================================ */

/* The assistant consults the documents AND runs a live web search before it
   answers, so the wait runs a second or two longer than a bare model call.
   Rather than a frozen "retrieving", cycle a rotating vocabulary under a
   turning OpenAI mark — the model doing the work is openai/gpt-oss-20b. */
const SPIN_WORDS = [
  'Vibing', 'Percolating', 'Discombobulating', 'Ruminating', 'Noodling',
  'Marinating', 'Simmering', 'Conjuring', 'Tinkering', 'Puzzling',
  'Cogitating', 'Wrangling', 'Finagling', 'Bamboozling', 'Frolicking',
  'Schlepping', 'Pondering', 'Scheming', 'Whirring', 'Untangling',
  'Spelunking', 'Divining', 'Manifesting', 'Incanting', 'Caffeinating',
  'Yak-shaving', 'Rubber-ducking', 'Overthinking', 'Enumerating', 'Fuzzing',
  'Pivoting', 'Grepping', 'Deobfuscating', 'Sandboxing', 'Triangulating',
  'Decrypting', 'Reticulating splines', 'Defenestrating', 'Hyperfixating',
  'Consulting the oracle', 'Bribing the GPU', 'Herding tokens',
];

const OAI_MARK = '<svg class="oai" viewBox="0 0 24 24" aria-hidden="true"><path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';

const Spinner = {
  timer: null, ticker: null, t0: 0, note: '',
  start(body) {
    this.stop();
    this.t0 = Date.now();
    this.note = '';
    let i = Math.floor(Math.random() * SPIN_WORDS.length);
    body.innerHTML = '<span class="spin">' + OAI_MARK +
      '<span class="spin-word"></span><span class="dots"></span>' +
      '<span class="tick"></span></span><span class="cursor-blk"></span>';
    const word = body.querySelector('.spin-word');
    const tick = body.querySelector('.tick');
    const paint = () => {
      word.textContent = SPIN_WORDS[i % SPIN_WORDS.length];
      const secs = Math.round((Date.now() - this.t0) / 1000);
      tick.textContent = (secs ? secs + 's' : '') +
        (this.note ? (secs ? ' \u00b7 ' : '') + this.note : '');
    };
    paint();
    this.timer  = setInterval(() => { i++; paint(); }, 1700);
    this.ticker = setInterval(paint, 1000);
  },
  setNote(t) { this.note = t; },
  stop() {
    clearInterval(this.timer); clearInterval(this.ticker);
    this.timer = this.ticker = null;
  },
};

/* Provider lights. Which model answered is worth showing: Gemini's free tier
   allows 250,000 tokens a minute and Groq's allows 8,000, so a silent fallback
   from one to the other is the difference between the assistant keeping up and
   rate limiting. The worker names the provider in a frame ahead of each answer,
   and /status reports both — one KV read, no model call — so a limit hit by any
   visitor shows for everyone. */
const ProviderLights = {
  els: null, until: { gemini: 0, groq: 0 }, primary: 'groq',

  init() {
    this.els = {
      gemini: $('#prov-gemini'),
      groq: $('#prov-groq'),
    };
    if (!this.els.groq) return;
    this.poll();
    setInterval(() => { if (document.visibilityState === 'visible') this.poll(); }, 30000);
    setInterval(() => this.paint(), 1000);
    addEventListener('online', () => this.poll());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.poll();
    });
  },

  /* Called when an answer names the provider that produced it. */
  active(name) {
    if (!this.els || !this.els[name]) return;
    this.primary = name;
    this.paint();
  },

  limited(name, seconds) {
    this.until[name] = Date.now() / 1000 + Math.max(1, seconds || 0);
    this.paint();
  },

  paint() {
    if (!this.els) return;
    for (const name of ['gemini', 'groq']) {
      const el = this.els[name];
      if (!el) continue;
      const left = Math.max(0, Math.ceil(this.until[name] - Date.now() / 1000));
      if (!left) this.until[name] = 0;
      el.classList.toggle('limited', left > 0);
      el.classList.toggle('on', left === 0 && this.primary === name);
      el.title = left > 0
        ? name + ' is rate limited \u2014 about ' + left + 's left. Every command still works.'
        : this.primary === name
          ? name + ' is answering.'
          : name + ' is configured and standing by.';
    }
  },

  async poll() {
    try {
      const r = await fetch(CHAT_ENDPOINT + 'status', { cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      const provs = d.providers || {};
      if (this.els.gemini) this.els.gemini.hidden = !(provs.gemini && provs.gemini.configured);
      if (d.primary) this.primary = d.primary;
      for (const name of ['gemini', 'groq']) {
        const p = provs[name];
        if (p && p.state === 'limited') this.limited(name, p.seconds || 10);
        else if (Date.now() / 1000 >= this.until[name]) this.until[name] = 0;
      }
      /* Older worker, single provider. */
      if (!d.providers && d.groq === 'limited') this.limited('groq', d.seconds || 10);
      this.paint();
    } catch (e) { /* offline, or the worker is unreachable — leave it as it is */ }
  },
};

const Term = {
  stream: null, input: null, promptEl: null,
  hist: [], histIdx: -1, draft: '',

  init() {
    this.stream   = $('#stream');
    this.input    = $('#cmdline');
    this.promptEl = $('#prompt');
    this.hist     = store.get('term.hist', []).slice(-60);
    this.histIdx  = this.hist.length;

    this.input.addEventListener('keydown', e => this.onKey(e));
    this.input.addEventListener('input', () => {
      /* Start fetching the embedding table on the first keystroke, so it is
         usually there by the time the question is submitted. */
      if (typeof Embed !== 'undefined') Embed.load();
      this.suggest();
    });
    this.ghostTyped = $('.g-typed');
    this.ghostRest  = $('.g-rest');
    $('#go').addEventListener('click', () => {
      const v = this.input.value;
      this.input.value = '';
      this.suggest();
      this.run(v);
    });

    /* Clicking anywhere in the shell focuses the prompt — but not when
       the visitor is selecting text or hitting a link/button. */
    $('#shell').addEventListener('click', e => {
      if (window.getSelection().toString()) return;
      if (e.target.closest('a, button, input, textarea, .modal')) return;
      this.focus();
    });

    $$('[data-cmd]').forEach(el =>
      el.addEventListener('click', () => this.run(el.dataset.cmd, true)));
  },

  /* Inline completion, against the command list and nothing else.

     Deliberately not history or the suggested questions: this is a terminal,
     and a terminal completes commands. Suggesting a half-remembered previous
     question as you type a new one is noise, and completing free text would
     be guessing at what someone means to ask.

     Only canonical command names are offered — never aliases, since
     completing "/cyber" to "/cybersecurity-news" is helpful but completing it
     to a second name for the same thing is just confusing. */
  suggest() {
    const v = this.input.value;
    const clear = () => { this.ghostTyped.textContent = ''; this.ghostRest.textContent = ''; this.pending = ''; };

    // Only for a command being typed: needs the slash, and nothing after a space.
    if (!v.startsWith('/') || /\s/.test(v) || v.length < 2) return clear();

    const typed = v.slice(1).toLowerCase();
    const match = Object.keys(COMMANDS).find(c => c.startsWith(typed) && c !== typed);
    if (!match) return clear();

    this.ghostTyped.textContent = v;
    this.ghostRest.textContent = match.slice(typed.length);
    this.pending = '/' + match;
  },

  accept() {
    if (!this.pending) return false;
    this.input.value = this.pending;
    this.suggest();
    return true;
  },

  /* On a phone, focusing the input throws up the keyboard and eats the
     screen. Only auto-focus a pointer device. */
  focus() {
    if (matchMedia('(hover:hover) and (pointer:fine)').matches) {
      this.input.focus({ preventScroll: true });
    }
  },

  onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = this.input.value;
      this.input.value = '';
      this.suggest();
      this.run(v);
      return;
    }
    /* Right arrow at the end of the line accepts the completion, the way a
       shell does. Anywhere else it just moves the caret. */
    if (e.key === 'ArrowRight' &&
        this.input.selectionStart === this.input.value.length &&
        this.input.selectionStart === this.input.selectionEnd) {
      if (this.accept()) { e.preventDefault(); return; }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.hist.length) return;
      e.preventDefault();
      if (this.histIdx === this.hist.length) this.draft = this.input.value;
      this.histIdx += e.key === 'ArrowUp' ? -1 : 1;
      this.histIdx = Math.max(0, Math.min(this.hist.length, this.histIdx));
      this.input.value = this.histIdx === this.hist.length ? this.draft : this.hist[this.histIdx];
      this.suggest();
      requestAnimationFrame(() => this.input.setSelectionRange(9999, 9999));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (this.accept()) return;              // take the ghost first
      const v = this.input.value.trim();
      if (!v.startsWith('/')) return;
      const m = Object.keys(COMMANDS).filter(c => c.startsWith(v.slice(1).toLowerCase()));
      if (m.length > 1) {                     // ambiguous — list them, as a shell does
        this.echo(v);
        this.print(m.map(c => '/' + c).join('   '), 'dim sp');
      }
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.clear(); }
    if (e.key === 'Escape') { this.input.value = ''; this.suggest(); Modal.close(); }
  },

  /* ── output ─────────────────────────────────────────────── */
  print(text, cls) {
    const d = document.createElement('div');
    d.className = 'line' + (cls ? ' ' + cls : '');
    d.textContent = text == null ? '' : String(text);
    this.stream.appendChild(d);
    this.scroll();
    return d;
  },
  html(markup) {
    const d = document.createElement('div');
    d.innerHTML = markup;
    this.stream.appendChild(d);
    this.scroll();
    return d;
  },
  echo(cmd) {
    this.html('<div class="echo"><span class="ps1">' + PS1 + '</span><span class="cmd">' +
              esc(cmd) + '</span></div>');
  },
  gap() { this.print('', 'sp'); },
  scroll() { this.stream.scrollTop = this.stream.scrollHeight; },
  clear() { this.stream.innerHTML = ''; },
  busy(on) { this.promptEl.classList.toggle('busy', !!on); this.input.disabled = !!on; if (!on) this.focus(); },

  /* ── dispatch ───────────────────────────────────────────── */
  async run(raw, fromChip) {
    const line = String(raw || '').trim();
    if (!line) { this.echo(''); return; }

    if (this.hist[this.hist.length - 1] !== line) this.hist.push(line);
    this.hist = this.hist.slice(-60);
    this.histIdx = this.hist.length;
    store.set('term.hist', this.hist);

    this.echo(line);
    if (fromChip) { this.input.value = ''; this.suggest(); }

    if (line.startsWith('/')) {
      const [word, ...rest] = line.slice(1).split(/\s+/);
      const key = word.toLowerCase();
      const cmd = COMMANDS[key] || COMMANDS[ALIASES[key]];
      if (cmd) { await cmd.run(rest.join(' ').trim(), this); this.focus(); return; }
      this.print('command not found: /' + word, 'err');
      const near = Object.keys(COMMANDS).filter(c => c.startsWith(key[0] || ''));
      this.print(near.length ? 'did you mean: ' + near.slice(0, 4).map(c => '/' + c).join(', ') + '?'
                             : 'type /help for the command list', 'dim sp');
      this.focus();
      return;
    }

    /* Not a slashed command — it's a question for the assistant. Commands
       require the leading slash; a bare word like "news" or "here" is treated
       as plain language, never silently run as a command. */
    await this.ask(line);
  },


  async ask(question) {
    this.busy(true);
    const wrap = this.html(
      '<div class="msg ai thinking"><div class="who">assistant</div>' +
      '<div class="body"></div></div>').firstElementChild;
    const body = wrap.querySelector('.body');
    Spinner.start(body);

    let first = true;
    const onToken = t => {
      if (first) { Spinner.stop(); body.textContent = ''; wrap.classList.remove('thinking'); first = false; }
      body.textContent += t;
      this.scroll();
    };

    /* The model reasons before it answers, and that phase renders nothing.
       Show it counting rather than a frozen "retrieving". */
    let thought = 0;
    const onStatus = (n, info) => {
      if (!first) return;                 // the answer has started; leave it alone

      /* A rate limit is being waited out — count it down rather than
         freezing, so the wait reads as deliberate instead of broken. */
      if (info && info.reset) {
        /* Memory reset — either proactively when the 3-exchange bar filled, or
           because a request hit the model's token limit. Show it plainly. */
        this.print(info.proactive
          ? '\u26a0 memory full — context reset. Answering fresh.'
          : '\u26a0 conversation was too long — memory reset automatically.', 'warn sp');
        updateMem();
        Spinner.start(body);
        if (!info.proactive) Spinner.setNote('fresh context');
        this.scroll();
        return;
      }
      if (info && info.verifying) {
        Spinner.stop();
        body.innerHTML = 'verifying session<span class="dots"></span><span class="cursor-blk"></span>';
        this.scroll();
        return;
      }
      if (info && info.waiting) {
        Spinner.stop();
        let left = info.waiting;
        clearInterval(this._rlTimer);
        const tickDown = () => {
          if (!first) { clearInterval(this._rlTimer); return; }
          /* Say what still works while the wait runs, not only afterwards in
             the error: a visitor staring at a countdown assumes the whole
             site is down. */
          body.innerHTML = '<span class="warn">rate limited</span> — retrying in ' +
            '<span class="tick">' + left + 's</span><span class="cursor-blk"></span>' +
            '<div class="line dim" style="margin-top:6px">Every command still works — ' +
            '/news, /publications, /sources, /show. Only free-text questions wait.</div>';
          if (--left < 0) clearInterval(this._rlTimer);
        };
        tickDown();
        this._rlTimer = setInterval(tickDown, 1000);
        this.scroll();
        return;
      }

      clearInterval(this._rlTimer);
      thought += n;
      if (!Spinner.timer) Spinner.start(body);
      Spinner.setNote(thought + ' chars');
    };

    try {
      const { cites, local, grounded, sources, followUp } = await Chat.ask(question, onToken, onStatus);
      clearInterval(this._rlTimer);
      Spinner.stop();
      if (first) {
        /* The model streamed reasoning but no answer — it spent its output
           budget thinking. Say what happened and what helps, rather than a
           bare "(no answer returned)". */
        body.textContent = 'The model used its whole budget reasoning and returned no answer. '
          + 'Ask again, more specifically \u2014 or run /reset first.';
        wrap.classList.remove('thinking');
      }

      if (!local) {
        const c = document.createElement('div');
        c.className = 'cites';
        /* Say where the answer came from, three ways never mistaken for each
           other: the corpus (named doc chips), a live web search (clickable
           link chips), or the model's own memory (a plain marker). */
        const parts = [];
        if (cites.length) {
          parts.push('<b>sources:</b>' + cites.map(s => '<span class="cite">' + esc(s) + '</span>').join(''));
        }
        if (sources && sources.length) {
          parts.push('<b>web:</b>' + sources.map(src =>
            '<a class="cite web" href="' + esc(src.url) + '" target="_blank" rel="noopener nofollow">' +
            esc(hostOf(src.url)) + '</a>').join(''));
        }
        if (!parts.length && !followUp) {
          parts.push('<span class="cite ungrounded">general knowledge — not from Valency\u2019s documents</span>');
        }
        c.innerHTML = parts.join('');
        if (c.innerHTML) wrap.appendChild(c);
      }
    } catch (err) {
      clearInterval(this._rlTimer);
      Spinner.stop();
      wrap.classList.remove('thinking');
      body.textContent = '';
      const e = document.createElement('div');
      e.className = 'line ' + (err.rateLimited ? 'warn' : 'err');
      e.textContent = err.rateLimited ? err.message : 'assistant error: ' + err.message;
      wrap.appendChild(e);
      const hint = document.createElement('div');
      hint.className = 'line dim';
      hint.textContent = err.rateLimited
        ? 'Every command still works \u2014 /news, /publications, /sources, /show. Only free-text '
          + 'questions wait. Press \u2191 to bring yours back, then Enter to retry.'
        : 'Every command still works — this only affects free-text questions. Try /help.';
      wrap.appendChild(hint);
    }
    this.busy(false);
    this.scroll();
    updateMem();
  },
};

const PS1 = 'visitor@colaco.se:~$';

/* The context meter in the title bar: how many of the last 10 exchanges the
   assistant is currently holding as follow-up context. */
function updateMem() {
  const el = $('#mem');
  if (!el) return;
  const used = (typeof Chat !== 'undefined' && Chat.memTokens) ? Chat.memTokens() : 0;
  const pct = Math.max(0, Math.min(100, used / 8000 * 100));
  const fill = el.querySelector('.mem-fill');
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  el.classList.toggle('warn', pct >= 55 && pct < 75);
  el.classList.toggle('full', pct >= 75);
  el.setAttribute('aria-label', '~' + used + ' of 8000 tokens used');
  el.title = 'Conversation token load: ~' + used + ' / 8000 per-minute limit. Resets automatically as it fills; /reset clears it now.';
}

/* Short, readable label for a web-source chip: the hostname without www. */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (e) { return url.slice(0, 40); }
}

/* ============================================================
   Modal manager
   ============================================================ */
const Modal = {
  open(id, title) {
    const panel = document.getElementById('panel-' + id);
    if (!panel) return false;
    this.close();
    const stage = $('#modal-body');
    stage.appendChild(panel);          // moved, not cloned — listeners survive
    panel.hidden = false;
    $('#modal-title').textContent = title || id;
    $('#modal-shell').classList.toggle('wide', panel.dataset.wide === '1');
    $('#modal').classList.add('show');
    document.body.classList.add('modal-open');
    this.current = id;
    $('#modal-close').focus({ preventScroll: true });
    return true;
  },
  close() {
    const stage = $('#modal-body');
    if (!stage) return;
    Array.from(stage.children).forEach(node => {
      node.hidden = true;
      $('#panels').appendChild(node);  // put it back where it lives
    });
    $('#modal').classList.remove('show');
    document.body.classList.remove('modal-open');
    this.current = null;
  },
  init() {
    $('#modal-close').addEventListener('click', () => this.close());
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') this.close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.current) {
        this.close();
      }
    });
  },
};

/* ============================================================
   Commands
   ============================================================ */
/* Shared by /clear-memory and /reset — the same act under two names, because
   people reach for both. Documents are untouched: /forget and /restart do
   those. */
function forgetConversation(t) {
  const n = (typeof Chat !== 'undefined') ? Chat.reset() : 0;
  const pairs = n / 2 | 0;
  t.print(pairs
    ? 'memory cleared \u2014 ' + pairs + ' exchange' + (pairs === 1 ? '' : 's') + ' forgotten.'
    : 'nothing to clear \u2014 no conversation yet.', 'ok');
  t.print('The assistant no longer has the earlier messages, the place, or the topic as context. '
        + 'Uploaded documents are untouched.', 'dim sp');
  updateMem();
}

const ALIASES = {
  cyber: 'cybersecurity-news', sec: 'cybersecurity-news', security: 'cybersecurity-news',
  threats: 'cybersecurity-news', infosec: 'cybersecurity-news',
  research: 'publications', papers: 'publications', pubs: 'publications',
  kev: 'cve', vulns: 'cve',
  hello: 'contact', email: 'contact', hire: 'contact',
  docs: 'sources', kb: 'sources',
  bio: 'about', me: 'about',
  cls: 'clear', reboot: 'restart', 'new': 'reset', mem: 'memory', remember: 'memory',
  clearmemory: 'clear-memory', 'forget-memory': 'clear-memory', forget_chat: 'reset', man: 'help', '?': 'help',
  quit: 'exit', q: 'exit', su: 'sudo', root: 'sudo',
};

const COMMANDS = {
  'help': {
    desc: 'list every command',
    run(_, t) {
      t.print('AVAILABLE COMMANDS', 'hd');
      t.html('<div class="cmd-grid">' + Object.entries(COMMANDS)
        .map(([k, c]) => '<div class="cmd-row"><b data-cmd="/' + k + '" style="cursor:pointer">/' + k +
                         '</b><span>' + esc(c.desc) + '</span></div>').join('') + '</div>');
      $$('#stream .cmd-row b[data-cmd]').forEach(el => {
        if (el.dataset.bound) return;
        el.dataset.bound = '1';
        el.addEventListener('click', () => Term.run(el.dataset.cmd, true));
      });
      t.print('Anything that is not a command is a question for the AI assistant.', 'dim');
      t.print('It answers only from the documents in /sources. Try /fun for ideas.', 'dim sp');
    }
  },

  'about': {
    desc: 'who Valency is',
    run(_, t) { Modal.open('about', 'about — valency oscar colaco'); }
  },

  'whoami': {
    desc: 'the one-line version',
    run(_, t) {
      t.print('valency oscar colaco', 'ok');
      t.print('cybersecurity & ai/ml researcher · linköping university, sweden');
      t.print('adversarial ml · tree-ensemble intrusion detection · real-time evasion defence');
      t.print('/about for the long version · /publications for the papers', 'dim sp');
    }
  },

  'publications': {
    desc: 'published papers',
    run(_, t) { Modal.open('research', 'publications — published papers'); }
  },

  'cybersecurity-news': {
    desc: 'live threat intel, advisories & KEV',
    run(_, t) {
      Modal.open('security', 'cybersecurity — intel desk');
      Sec.load();
    }
  },

  'news': {
    desc: 'top stories with media-bias breakdown',
    run(_, t) {
      Modal.open('news', 'news — top stories');
      News.load();
    }
  },

  'cve': {
    desc: 'CISA known-exploited vulnerabilities',
    run(_, t) {
      Modal.open('security', 'cybersecurity — known exploited vulns');
      const btn = $('#panel-security .tabs button[data-tab="kev"]');
      if (btn) btn.click(); else Sec.load();
    }
  },

  'card': {
    desc: 'contact details and photo',
    run(_, t) { Modal.open('card', 'contact card — valency oscar colaco'); }
  },

  'contact': {
    desc: 'send Valency a message',
    run(_, t) { Modal.open('contact', 'contact — direct line'); }
  },

  'scholar': {
    desc: 'open the Google Scholar profile',
    run(_, t) {
      const url = 'https://scholar.google.com/citations?user=xMG8t8oAAAAJ&hl=en';
      t.print('opening ' + url + ' …', 'dim');
      window.open(url, '_blank', 'noopener');
    }
  },

  'sources': {
    desc: 'documents the assistant may read',
    async run(_, t) {
      t.print('loading knowledge base…', 'dim');
      try { await RAG.load(); } catch (e) { t.print(e.message, 'err'); return; }
      renderSources(t);
    }
  },

  'show': {
    desc: 'print a source document \u2014 /show maverick, /show my upload',
    async run(arg, t) {
      try { await RAG.load(); } catch (e) { t.print(e.message, 'err'); return; }
      const list = () => RAG.docs.forEach(d =>
        t.print('  ' + d.file + '  \u2014  ' + d.title, 'dim'));
      const a = (arg || '').trim().toLowerCase();
      if (!a) {
        t.print('usage: /show <name>   e.g. /show maverick', 'dim');
        t.print('DOCUMENTS', 'hd');
        list();
        return;
      }
      /* Match on words, not on one literal substring: people type "/show
         maverick paper", "/show the iceman paper", "/show siem rules". Filler
         words that describe the KIND of thing rather than which one are
         dropped, then documents are ranked by how many of the remaining words
         they carry, so the extra word narrows the search instead of breaking
         it. An exact substring still wins outright. */
      const FILLER = new Set(['the', 'a', 'an', 'paper', 'papers', 'doc', 'docs',
        'document', 'documents', 'file', 'files', 'source', 'sources', 'pdf', 'md',
        'markdown', 'please', 'me', 'out', 'full', 'my', 'mine', 'i', 'just',
        'uploaded', 'upload', 'uploads', 'added', 'own', 'that', 'this', 'one', 'it']);
      const hay = d => (d.title + ' ' + d.file).toLowerCase();

      /* "/show the source I just uploaded" names no document, it points at
         one. When the phrasing refers to the visitor's own files, only those
         are considered — and if nothing in the phrase distinguishes between
         them, "just uploaded" means the most recent. */
      const refersToUpload = /\b(uploaded|upload|uploads|mine|my)\b/i.test(a);
      const session = RAG.docs.filter(d => d.session);
      if (refersToUpload && !session.length) {
        t.print('you have not uploaded anything this session \u2014 /upload takes a .txt, .pdf or .docx.', 'warn');
        t.print('DOCUMENTS', 'hd'); list();
        return;
      }
      const pool = refersToUpload ? session : RAG.docs;

      let hits = pool.filter(d => hay(d).includes(a));
      if (!hits.length) {
        /* Three characters minimum, and no fallback to the unfiltered words:
           "i" in "the source i just uploaded" substring-matches "revIew" and
           "frostbIte", which tied both uploads and reported them ambiguous. */
        const terms = a.split(/[\s,._\-\u2014\u2013]+/)
          .filter(w => w.length >= 3 && !FILLER.has(w));
        const scored = pool
          .map(d => ({ d, n: terms.filter(w => hay(d).includes(w)).length }))
          .filter(x => x.n > 0)
          .sort((x, y) => y.n - x.n);
        if (scored.length) {
          const best = scored[0].n;
          hits = scored.filter(x => x.n === best).map(x => x.d);
        }
      }
      /* Pointed at an upload but nothing in the phrase picks one out. */
      if (!hits.length && refersToUpload) hits = [session[session.length - 1]];
      if (!hits.length) {
        t.print('no source matching "' + arg.trim() + '"', 'err');
        t.print('DOCUMENTS', 'hd'); list();
        return;
      }
      if (hits.length > 1) {
        t.print('"' + arg.trim() + '" matches ' + hits.length + ' documents \u2014 be more specific:', 'warn');
        hits.forEach(d => t.print('  ' + d.file + '  \u2014  ' + d.title, 'dim'));
        return;
      }
      const d = hits[0];
      t.print(d.title, 'hd');
      t.print(d.file + ' \u00b7 ' + d.chunks + ' chunks \u00b7 ' +
        (d.chars < 1024 ? d.chars + ' B' : Math.round(d.chars / 1024) + ' KB') +
        ' \u2014 exactly what the assistant reads', 'dim');
      const wrap = t.html('<pre class="doc-dump" tabindex="0"></pre>');
      wrap.querySelector('.doc-dump').textContent = RAG.docText(d.file);
      t.scroll();
    }
  },

  'forget': {
    desc: 'remove an uploaded document — name, or "all"',
    async run(arg, t) {
      await RAG.load().catch(() => {});
      const session = RAG.docs.filter(d => d.session);
      if (!session.length) { t.print('nothing to forget — no documents uploaded this session.', 'dim sp'); return; }
      const a = (arg || '').trim();
      if (!a) {
        t.print('usage: /forget <filename>   or   /forget all', 'dim');
        t.print('uploaded: ' + session.map(d => d.file).join(', '), 'dim sp');
        return;
      }
      const gone = RAG.dropSessionDoc(a.toLowerCase() === 'all' ? undefined : a);
      if (!gone.length) {
        t.print('no uploaded document called "' + a + '"', 'err');
        t.print('uploaded: ' + session.map(d => d.file).join(', '), 'dim sp');
        return;
      }
      gone.forEach(n => t.print('[removed] ' + n, 'ok'));
      t.print(RAG.chunks.length + ' chunks left in the corpus.', 'dim sp');
    }
  },

  'upload': {
    desc: 'add your own documents (this session)',
    run(_, t) {
      $('#file-input').click();
      t.print('file picker open \u2014 .txt, .pdf or .docx (8 MB max)', 'dim');
      t.print('each is converted to Markdown in your browser, then searched FIRST \u2014 '
            + 'ahead of the web and of Valency\u2019s knowledge base.', 'dim');
      t.print('or just drag files anywhere onto this page.', 'dim sp');
    }
  },

  'fun': {
    desc: 'things worth asking the assistant',
    run(_, t) {
      t.print('TRY ASKING', 'hd');
      t.print('Type any of these — or click one. The assistant answers from Valency\'s documents.', 'dim');
      t.html('<div class="hints" style="padding:10px 0 4px">' + FUN.map(q =>
        '<button class="chip" data-ask="' + esc(q) + '">' + esc(q) + '</button>').join('') + '</div>');
      $$('#stream .chip[data-ask]').forEach(el => {
        if (el.dataset.bound) return;
        el.dataset.bound = '1';
        el.addEventListener('click', () => Term.run(el.dataset.ask, true));
      });
      t.print('Ask it anything off-topic and it will refuse. That is the point.', 'dim sp');
    }
  },

  'theme': {
    desc: 'phosphor colour — green | amber | ice',
    run(arg, t) {
      const themes = ['green', 'amber', 'ice'];
      let next = (arg || '').toLowerCase();
      if (!themes.includes(next)) {
        const cur = document.documentElement.dataset.theme || 'green';
        next = themes[(themes.indexOf(cur) + 1) % themes.length];
      }
      if (next === 'green') delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = next;
      store.set('term.theme', next);
      t.print('phosphor set to ' + next, 'ok');
      t.gap();
    }
  },

  'restart': {
    desc: 'wipe everything and boot fresh',
    async run(_, t) {
      /* A restart, not a tidy-up: the transcript, the conversation the
         assistant remembers, the place and topic it was tracking, and every
         uploaded document all go. The corpus under knowledge/ is read-only
         and comes back with the boot, as it would on a real machine. Command
         history and the phosphor theme survive, the way a shell's history
         file and your settings survive a reboot. */
      const exchanges = (typeof Chat !== 'undefined') ? (Chat.reset() / 2 | 0) : 0;
      const dropped = (typeof RAG !== 'undefined' && RAG.dropSessionDoc) ? RAG.dropSessionDoc() : [];

      t.clear();
      updateMem();
      t.print('shutting down …', 'dim');
      await sleep(220);
      await bootSequence();

      const gone = [];
      if (exchanges) gone.push(exchanges + ' exchange' + (exchanges === 1 ? '' : 's'));
      if (dropped.length) gone.push(dropped.length + ' uploaded document' + (dropped.length === 1 ? '' : 's'));
      t.print(gone.length
        ? 'restarted \u2014 ' + gone.join(' and ') + ' forgotten.'
        : 'restarted \u2014 nothing was in memory.', 'ok');
      t.gap();
    }
  },

  'banner': {
    desc: 'reprint the banner',
    run(_, t) { printBanner(t); }
  },

  'memory': {
    desc: 'what the assistant remembers from this conversation',
    run(_, t) {
      if (typeof Chat === 'undefined') { t.print('assistant not loaded yet.', 'err'); return; }
      const h = Chat.history;
      const pairs = h.length / 2 | 0;
      const tok = Chat.memTokens ? Chat.memTokens() : 0;

      t.print('CONVERSATION MEMORY', 'hd');
      t.print('held        ' + (pairs || 'no') + ' exchange' + (pairs === 1 ? '' : 's')
            + '  \u00b7  ~' + tok + ' of 8000 tokens per minute'
            + '  \u00b7  clears itself past ' + RESET_TOKENS, 'dim');

      /* State the assistant derived rather than was told — this is the part
         that decides how a follow-up is answered, and it is invisible
         everywhere else. */
      const derived = [];
      if (Chat.place) derived.push(['place  ', Chat.place, 'where "here" and "nearby" resolve to']);
      if (Chat.topic) derived.push(['topic  ', Chat.topic.slice(0, 60), 'what a follow-up is taken to be about']);
      if (Chat.topic) derived.push(['sourced', Chat.topicGrounded ? "Valency's documents" : 'web search and general knowledge',
                                    'where follow-ups on this topic look']);
      if (derived.length) {
        t.gap();
        t.print('INFERRED', 'hd');
        derived.forEach(([k, v, why]) => t.print('  ' + k + '  ' + v + '   \u2014 ' + why, 'dim'));
      }

      if (!h.length) {
        t.gap();
        t.print('No messages yet \u2014 nothing is being carried into the next answer.', 'dim sp');
      } else {
        t.gap();
        t.print('MESSAGES', 'hd');
        for (let i = 0; i < h.length; i += 2) {
          const q = h[i], a = h[i + 1];
          const n = String(i / 2 + 1).padStart(2, ' ');
          const cut = (m, len) => {
            const one = String((m && m.content) || '').replace(/\s+/g, ' ');
            return one.length > len ? one.slice(0, len) + '\u2026' : one;
          };
          t.print(n + '  you        ' + cut(q, 110), '');
          if (a) t.print('    assistant  ' + cut(a, 150), 'dim');
        }
      }

      const up = (typeof RAG !== 'undefined' ? RAG.docs.filter(d => d.session) : []);
      if (up.length) {
        t.gap();
        t.print('YOUR DOCUMENTS', 'hd');
        up.forEach(d => t.print('  ' + d.file + '  \u00b7  ' + d.chunks +
          (d.chunks === 1 ? ' chunk' : ' chunks') + '  \u2014 searched before the web and the knowledge base', 'dim'));
      }

      t.gap();
      t.print('Not all of this is sent with every question: older exchanges go only when they '
            + 'share wording with what you ask, and passages are cut to the sentences that answer it.', 'dim');
      t.print('/clear-memory forgets the conversation \u00b7 /forget removes a document \u00b7 '
            + '/restart wipes both.', 'dim sp');
    }
  },

  'clear-memory': {
    desc: 'forget the conversation (documents stay)',
    run(_, t) { forgetConversation(t); }
  },

  'reset': {
    desc: 'forget the conversation history',
    run(_, t) { forgetConversation(t); }
  },

  'clear': {
    desc: 'clear the screen',
    run(_, t) { t.clear(); }
  },

  'date': {
    desc: 'local time in Sweden and here',
    run(_, t) {
      const now = new Date();
      t.print('here    ' + now.toString().replace(/\s\(.*\)$/, ''));
      t.print('sweden  ' + now.toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) + ' (Europe/Stockholm)');
      t.gap();
    }
  },

  'sudo': {
    desc: 'no',
    run(arg, t) {
      t.print('visitor is not in the sudoers file. This incident has been reported.', 'err');
      t.gap();
    }
  },

  'exit': {
    desc: 'close the open panel',
    run(_, t) {
      if (Modal.current) { Modal.close(); t.print('panel closed', 'dim sp'); }
      else t.print('nothing open. this terminal has no exit — that is the joke.', 'dim sp');
    }
  },
};

/* Renders the corpus listing, with a remove control on anything the visitor
   added themselves. Files under knowledge/ have no control — they are part of
   the site, not the session, and are not the visitor's to drop. */
function renderSources(t) {
  t.print('KNOWLEDGE BASE', 'hd');
  const rows = RAG.docs.map(d =>
    '<div class="doc-row" data-doc="' + esc(d.file) + '">' +
      '<span class="ok">[ok]</span>' +
      '<span class="nm">' + esc(d.title) +
        (d.session ? ' <span class="tag-session">session</span>' : '') +
      '</span>' +
      '<span class="sz">' + d.chunks + (d.chunks === 1 ? ' chunk · ' : ' chunks · ') +
        (d.chars < 1024 ? d.chars + ' B' : Math.round(d.chars / 1024) + ' KB') + '</span>' +
      (d.session ? '<button class="rm" data-rm="' + esc(d.file) + '" title="Remove from this session">remove</button>'
                 : '<span class="rm-spacer"></span>') +
    '</div>').join('');
  const el = t.html('<div class="docs-list">' + rows + '</div>');

  el.querySelectorAll('[data-rm]').forEach(btn =>
    btn.addEventListener('click', () => {
      const name = btn.dataset.rm;
      const gone = RAG.dropSessionDoc(name);
      if (!gone.length) return;
      Term.echo('/forget ' + name);
      Term.print('[removed] ' + name, 'ok');
      Term.print(RAG.chunks.length + ' chunks left in the corpus.', 'dim sp');
      renderSources(Term);          // reprint so the listing matches reality
    }));

  const session = RAG.docs.filter(d => d.session).length;
  t.print(RAG.docs.length + (RAG.docs.length === 1 ? ' document · ' : ' documents · ') +
          RAG.chunks.length + ' chunks indexed', 'ok');
  t.print(session
    ? 'The assistant answers from these. /upload adds more, /forget removes yours.'
    : 'The assistant answers from these. /upload adds your own.', 'dim sp');
}

/* Suggested prompts — printed by /fun and shown under the prompt. */
const FUN = [
  'Which paper should I read first?',
  "What's the difference between Iceman and Maverick?",
  'Explain evasion attacks on tree ensembles like I have 60 seconds',
  'Why is adversarial retraining a bad idea for tree ensembles?',
  'What should I ask Valency about at a conference?',
  'Give me the elevator pitch for the licentiate thesis',
  'How fast is Maverick, and why does the speed matter?',
  'What is a SIGMA rule evasion?',
  'Summarise Valency in three bullet points for an intro slide',
  'Is any of this work relevant to automotive security?',
  'What can this website actually do?',
  'What model are you running on?',
  'Would Valency beat a random forest in a fight?',
  'Sell me on reading the thesis',
];

/* ============================================================
   Boot
   ============================================================ */
const BANNER = String.raw`
  ██████╗ ██████╗ ██╗      █████╗  ██████╗ ██████╗    ███████╗███████╗
 ██╔════╝██╔═══██╗██║     ██╔══██╗██╔════╝██╔═══██╗   ██╔════╝██╔════╝
 ██║     ██║   ██║██║     ███████║██║     ██║   ██║   ███████╗█████╗
 ██║     ██║   ██║██║     ██╔══██║██║     ██║   ██║   ╚════██║██╔══╝
 ╚██████╗╚██████╔╝███████╗██║  ██║╚██████╗╚██████╔╝██╗███████║███████╗
  ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═╝╚══════╝╚══════╝`;

/* 70 columns doesn't fit a phone at any readable size. */
/* Pure ASCII: box-drawing glyphs are not reliably monospace-width
   across mobile font stacks, and a banner that doesn't line up is worse
   than no banner. */
const BANNER_NARROW = String.raw`
 +---------------------------+
 |  C O L A C O . S E    >_  |
 +---------------------------+`;

function printBanner(t) {
  const d = document.createElement('pre');
  d.className = 'ascii';
  d.textContent = innerWidth < 620 ? BANNER_NARROW : BANNER;
  t.stream.appendChild(d);
  t.print('valency oscar colaco · cybersecurity & ai/ml researcher', 'ok');
  t.print(innerWidth < 620
    ? 'adversarial ml · intrusion detection'
    : 'adversarial machine learning · intrusion detection · real-time evasion defence', 'dim sp');
}

/* Two widths of the same boot log. The wide one wraps into mush on a
   phone, and a wrapped boot log looks broken rather than authentic. */
const BOOT_WIDE = [
  ['booting colaco.se …', 'dim', 90],
  ['[ok] display       phosphor green', 'ok', 60],
  ['[ok] feeds         thehackernews · krebs · securityweek · cisa · ground news', 'ok', 60],
  ['[ok] assistant     groq · gpt-oss-20b · retrieval-scoped', 'ok', 60],
  ['[ok] corpus        knowledge/ mounted read-only', 'ok', 60],
  ['', '', 120],
];
const BOOT_NARROW = [
  ['booting colaco.se …', 'dim', 90],
  ['[ok] display    phosphor', 'ok', 55],
  ['[ok] feeds      4 sources', 'ok', 55],
  ['[ok] assistant  gpt-oss-20b', 'ok', 55],
  ['[ok] corpus     read-only', 'ok', 55],
  ['', '', 100],
];

async function bootSequence() {
  const narrow = innerWidth < 620;
  for (const [text, cls, wait] of (narrow ? BOOT_NARROW : BOOT_WIDE)) {
    Term.print(text, cls);
    await sleep(wait);
  }
  printBanner(Term);
  if (narrow) {
    Term.print('/help for commands — or just ask a question.', 'dim');
    Term.print('/fun for things worth asking.', 'dim sp');
  } else {
    Term.print('Type /help for commands, or just ask a question in plain English.', 'dim');
    Term.print('Try /fun for things worth asking. Tab completes, ↑ recalls history.', 'dim sp');
  }
  Term.focus();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   Session document uploads
   ============================================================ */
/* Uploads are restricted to the three formats a visitor actually has —
   plain text, PDF, Word — and every one is converted to Markdown before it
   reaches the corpus, so retrieval only ever indexes one format. The
   conversion runs in the browser (see docconv.js): the file itself is never
   sent anywhere. */
async function ingestFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  await RAG.load().catch(() => {});
  let added = 0;
  for (const f of list) {
    if (!UPLOAD_EXT.test(f.name)) {
      Term.print('[skip] ' + f.name + ' \u2014 only .txt, .pdf and .docx can be uploaded.', 'warn');
      continue;
    }
    if (f.size > MAX_UPLOAD) {
      Term.print('[skip] ' + f.name + ' \u2014 over 8 MB.', 'warn');
      continue;
    }
    const line = Term.print('[..] ' + f.name + ' \u2014 converting to Markdown\u2026', 'dim');
    try {
      const { name, markdown } = await DocConv.toMarkdown(f, step => {
        line.textContent = '[..] ' + f.name + ' \u2014 converting to Markdown (' + step + ')';
        Term.scroll();
      });
      RAG.addSessionDoc(name, markdown);
      const kb = markdown.length < 1024
        ? markdown.length + ' B'
        : Math.round(markdown.length / 1024) + ' KB';
      line.className = 'line ok';
      line.textContent = '[ok] ' + f.name + ' \u2192 ' + name + ' \u2014 converted and indexed (' + kb + ' of Markdown)';
      added++;
    } catch (e) {
      line.className = 'line err';
      line.textContent = '[err] ' + f.name + ' \u2014 ' + e.message;
    }
  }
  if (added) {
    Term.print(added + ' document' + (added > 1 ? 's' : '') + ' converted to Markdown and indexed for this '
      + 'session only \u2014 the file never left your browser.', 'dim');
    Term.print('Your documents are now searched FIRST, ahead of the web and of Valency\u2019s knowledge base. '
      + 'Run /sources to see them, /forget to remove one.', 'dim sp');
  }
  Term.scroll();
}

/* The terminal is the page, so a wheel event over the empty margin around it
   should scroll the transcript rather than doing nothing. Anything that
   scrolls on its own — the transcript itself, a modal, a printed document —
   keeps its own wheel events, and the whole thing stands down when the page
   has its own scrollbar (narrow screens), where hijacking the wheel would
   trap the visitor. */
function initPageScroll() {
  addEventListener('wheel', e => {
    const s = Term.stream;
    if (!s) return;
    if (document.documentElement.scrollHeight > innerHeight + 2) return;
    for (let n = e.target; n && n !== document.body; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1) {
        const oy = getComputedStyle(n).overflowY;
        if (oy === 'auto' || oy === 'scroll') return;
      }
    }
    s.scrollTop += e.deltaY;
  }, { passive: true });
}

function initUploads() {
  $('#file-input').addEventListener('change', e => {
    ingestFiles(e.target.files);
    e.target.value = '';
  });

  const zone = $('#dropzone');
  let depth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); if (++depth === 1) zone.classList.add('show'); });
  addEventListener('dragover',  e => e.preventDefault());
  addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) { depth = 0; zone.classList.remove('show'); } });
  addEventListener('drop', e => {
    e.preventDefault(); depth = 0; zone.classList.remove('show');
    Term.echo('/upload');
    ingestFiles(e.dataTransfer.files);
  });
}

/* ============================================================
   Matrix rain — background only, deliberately faint
   ============================================================ */
function initMatrix() {
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const cv = $('#matrix');
  const ctx = cv.getContext('2d', { alpha: true });
  const GLYPHS = 'アカサタナハマヤラワ01234567890ABCDEF<>{}[]/\\|=+*#$%&';
  let cols = [], w = 0, h = 0, size = 14, raf = 0, last = 0;

  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = cv.width = innerWidth * dpr;
    h = cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
    size = (innerWidth < 720 ? 12 : 15) * dpr;
    ctx.font = size + 'px ui-monospace, monospace';
    const n = Math.ceil(w / size);
    cols = Array.from({ length: n }, () => ({
      y: Math.random() * -h,
      speed: (0.25 + Math.random() * 0.55) * size,
    }));
  };

  /* --bg0 as an rgba() with the trail alpha, recomputed cheaply per frame
     so a mid-session /theme switch is picked up immediately. */
  let lastBg = '', lastTrail = 'rgba(4,7,10,0.13)';
  const trailColour = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg0').trim();
    if (bg === lastBg) return lastTrail;
    lastBg = bg;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg);
    lastTrail = m
      ? 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',0.13)'
      : 'rgba(4,7,10,0.13)';
    return lastTrail;
  };

  const draw = ts => {
    raf = requestAnimationFrame(draw);
    if (ts - last < 55) return;                 // ~18fps: cheap, and it looks right
    last = ts;
    /* Trail decay. This has to be the CURRENT theme's background: it was
       hardcoded to the green theme's, so switching to amber or ice smeared
       a green-black wash over the new palette and old glyphs faded to the
       wrong colour. Read it from the same custom property the theme sets. */
    ctx.fillStyle = trailColour();
    ctx.fillRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#00ff9c';
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      const g = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      ctx.fillStyle = accent;
      ctx.fillText(g, i * size, c.y);
      c.y += c.speed;
      if (c.y > h && Math.random() > 0.975) c.y = Math.random() * -200;
    }
  };

  resize();
  addEventListener('resize', resize, { passive: true });
  raf = requestAnimationFrame(draw);
  document.addEventListener('visibilitychange', () => {
    /* don't burn a phone battery in a background tab */
    if (document.hidden) cancelAnimationFrame(raf);
    else raf = requestAnimationFrame(draw);
  });
}

/* Copy-to-clipboard on the contact card. The clipboard API needs a secure
   context and can be refused outright, so there is a selection-based
   fallback and, failing both, an honest message. */
function initCopy() {
  $$('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy;
      const ok = () => {
        const was = btn.textContent;
        btn.textContent = 'copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = was; btn.classList.remove('done'); }, 1500);
      };
      try {
        await navigator.clipboard.writeText(text);
        ok();
      } catch (e) {
        /* http:// or a permissions policy blocked it — select the value so
           the visitor can copy it by hand rather than being told nothing. */
        const val = btn.closest('.crow')?.querySelector('.crow-value');
        if (val) {
          const r = document.createRange();
          r.selectNodeContents(val);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          toast('Clipboard blocked — the value is selected, press ⌘C');
        } else {
          toast('Clipboard unavailable');
        }
      }
    });
  });
}

/* ============================================================
   Contact form
   ============================================================ */
function initContact() {
  const next = $('#next-url');
  if (next && /^https?:$/.test(location.protocol)) {
    next.value = location.origin + location.pathname + '?sent=1';
  }
  if (new URLSearchParams(location.search).get('sent') === '1') {
    toast('Message sent — thank you!');
    history.replaceState(null, '', location.pathname);
  }
  $('#contact-form').addEventListener('submit', () => toast('Opening the captcha check…'));
}

/* ============================================================
   Boot
   ============================================================ */
(function main() {
  const saved = store.get('term.theme', 'green');
  if (saved && saved !== 'green') document.documentElement.dataset.theme = saved;

  Modal.init();
  Term.init();
  Sec.init();
  initContact();
  initCopy();
  initUploads();
  initPageScroll();
  ProviderLights.init();
  initMatrix();
  updateMem();

  $('#avatar-open').addEventListener('click', () => Term.run('/card', true));


  /* Deep links: colaco.se/#publications opens that panel on load. */
  const openFromHash = () => {
    const h = (location.hash || '').slice(1).toLowerCase();
    if (h && (COMMANDS[h] || ALIASES[h])) Term.run('/' + h, true);
  };
  addEventListener('hashchange', openFromHash);

  /* The gate runs behind the boot overlay; the terminal starts typing only
     once it lifts. Verification failure does not block anything here — only
     the assistant needs a pass. */
  runGate().then(() => bootSequence()).then(openFromHash);

  /* Warm the corpus in the background so the first question is fast. */
  setTimeout(() => RAG.load().catch(() => {}), 1200);
})();
