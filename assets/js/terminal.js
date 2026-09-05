/* ============================================================
   Terminal — command router, output stream, modal manager

   Modals do not re-render their contents. Each command's panel
   already exists in #panels; opening one MOVES the node into the
   modal stage and closing moves it back. That keeps every listener
   the feed and game modules bound at boot alive — nothing is
   cloned, nothing is re-wired.
   ============================================================ */

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
      this.run(v);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.hist.length) return;
      e.preventDefault();
      if (this.histIdx === this.hist.length) this.draft = this.input.value;
      this.histIdx += e.key === 'ArrowUp' ? -1 : 1;
      this.histIdx = Math.max(0, Math.min(this.hist.length, this.histIdx));
      this.input.value = this.histIdx === this.hist.length ? this.draft : this.hist[this.histIdx];
      requestAnimationFrame(() => this.input.setSelectionRange(9999, 9999));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const v = this.input.value.trim();
      if (!v.startsWith('/')) return;
      const m = Object.keys(COMMANDS).filter(c => c.startsWith(v.slice(1)));
      if (m.length === 1) this.input.value = '/' + m[0] + ' ';
      else if (m.length > 1) {
        this.echo(v);
        this.print(m.map(c => '/' + c).join('   '), 'dim sp');
      }
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.clear(); }
    if (e.key === 'Escape') { this.input.value = ''; Modal.close(); }
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
    if (fromChip) this.input.value = '';

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

    /* Not a command — it's a question for the assistant. */
    await this.ask(line);
  },

  async ask(question) {
    this.busy(true);
    const wrap = this.html(
      '<div class="msg ai thinking"><div class="who">assistant</div>' +
      '<div class="body"></div></div>').firstElementChild;
    const body = wrap.querySelector('.body');
    body.innerHTML = 'retrieving<span class="cursor-blk"></span>';

    let first = true;
    const onToken = t => {
      if (first) { body.textContent = ''; wrap.classList.remove('thinking'); first = false; }
      body.textContent += t;
      this.scroll();
    };

    /* The model reasons before it answers, and that phase renders nothing.
       Show it counting rather than a frozen "retrieving". */
    let thought = 0;
    const onStatus = n => {
      if (!first) return;                 // the answer has started; leave it alone
      thought += n;
      body.innerHTML = 'thinking<span class="dots"></span> ' +
        '<span class="tick">' + thought + ' chars</span><span class="cursor-blk"></span>';
    };

    try {
      const { cites, local } = await Chat.ask(question, onToken, onStatus);
      if (first) { body.textContent = '(no answer returned)'; wrap.classList.remove('thinking'); }
      if (cites && cites.length && !local) {
        const c = document.createElement('div');
        c.className = 'cites';
        c.innerHTML = '<b>sources:</b>' + cites.map(s => '<span class="cite">' + esc(s) + '</span>').join('');
        wrap.appendChild(c);
      }
    } catch (err) {
      wrap.classList.remove('thinking');
      body.textContent = '';
      const e = document.createElement('div');
      e.className = 'line err';
      e.textContent = 'assistant error: ' + err.message;
      wrap.appendChild(e);
      const hint = document.createElement('div');
      hint.className = 'line dim';
      hint.textContent = 'Every command still works — this only affects free-text questions. Try /help.';
      wrap.appendChild(hint);
    }
    this.busy(false);
    this.scroll();
  },
};

const PS1 = 'visitor@colaco.se:~$';

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
    if (typeof GameModal !== 'undefined') GameModal.close();
    this.current = null;
  },
  init() {
    $('#modal-close').addEventListener('click', () => this.close());
    $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') this.close(); });
    document.addEventListener('keydown', e => {
      /* the arcade owns Escape while a game is running */
      if (e.key === 'Escape' && this.current && !(typeof GameModal !== 'undefined' && GameModal.active)) {
        this.close();
      }
    });
  },
};

/* ============================================================
   Commands
   ============================================================ */
const ALIASES = {
  cyber: 'cybersecurity-news', sec: 'cybersecurity-news', security: 'cybersecurity-news',
  threats: 'cybersecurity-news', infosec: 'cybersecurity-news',
  research: 'publications', papers: 'publications', pubs: 'publications',
  kev: 'cve', vulns: 'cve',
  ponytail: 'agents', llm: 'agents',
  arcade: 'games', play: 'games',
  hello: 'contact', email: 'contact', hire: 'contact',
  docs: 'sources', kb: 'sources',
  bio: 'about', me: 'about',
  cls: 'clear', man: 'help', '?': 'help',
  quit: 'exit', q: 'exit',
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
    desc: 'five selected papers',
    run(_, t) { Modal.open('research', 'publications — selected research'); }
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

  'agents': {
    desc: 'make AI coding agents write less code',
    run(_, t) { Modal.open('ponytail', 'agents — ponytail integration guide'); }
  },

  'games': {
    desc: 'six browser games',
    run(_, t) { Modal.open('games', 'arcade — pick your poison'); }
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
      t.print('file picker open — .md .txt .json .csv .log', 'dim');
      t.print('or just drag files anywhere onto this page.', 'dim sp');
    }
  },

  'ask': {
    desc: 'ask the assistant explicitly',
    async run(arg, t) {
      if (!arg) { t.print('usage: /ask <question>   — or just type the question', 'dim sp'); return; }
      await t.ask(arg);
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

  'crt': {
    desc: 'scanlines & flicker — on | off',
    run(arg, t) {
      const want = (arg || '').toLowerCase();
      const on = want ? (want === 'on' || want === '1' || want === 'yes')
                      : document.documentElement.dataset.crt !== 'on';
      if (on) document.documentElement.dataset.crt = 'on';
      else delete document.documentElement.dataset.crt;
      store.set('term.crt', on);
      t.print('scanlines ' + (on ? 'on — authentic, and harder to read' : 'off'), 'ok');
      t.gap();
    }
  },

  'banner': {
    desc: 'reprint the banner',
    run(_, t) { printBanner(t); }
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
      t.print('(it has not been reported. there is no sudoers file. this is a static site.)', 'dim sp');
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
    ? 'The assistant answers from these and nothing else. /upload adds more, /forget removes yours.'
    : 'The assistant answers from these and nothing else. /upload adds your own.', 'dim sp');
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
  ['[ok] display       phosphor green · /crt for scanlines', 'ok', 60],
  ['[ok] feeds         thehackernews · bleepingcomputer · krebs · securityweek · cisa', 'ok', 60],
  ['[ok] assistant     groq · gpt-oss-20b · retrieval-scoped', 'ok', 60],
  ['[ok] corpus        knowledge/ mounted read-only', 'ok', 60],
  ['', '', 120],
];
const BOOT_NARROW = [
  ['booting colaco.se …', 'dim', 90],
  ['[ok] display    phosphor', 'ok', 55],
  ['[ok] feeds      5 sources', 'ok', 55],
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
const TEXT_EXT = /\.(md|markdown|txt|json|csv|log|yml|yaml|html?)$/i;

async function ingestFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  await RAG.load().catch(() => {});
  let added = 0;
  for (const f of list) {
    if (!TEXT_EXT.test(f.name)) {
      Term.print('[skip] ' + f.name + ' — not a text format. Convert PDFs with pdftotext first.', 'warn');
      continue;
    }
    if (f.size > 2 * 1024 * 1024) {
      Term.print('[skip] ' + f.name + ' — over 2 MB.', 'warn');
      continue;
    }
    try {
      RAG.addSessionDoc(f.name, await f.text());
      Term.print('[ok] ' + f.name + ' — indexed (' +
        (f.size < 1024 ? f.size + ' B' : Math.round(f.size / 1024) + ' KB') + ')', 'ok');
      added++;
    } catch (e) {
      Term.print('[err] ' + f.name + ' — ' + e.message, 'err');
    }
  }
  if (added) {
    Term.print(added + ' document' + (added > 1 ? 's' : '') + ' added for this session only — nothing is uploaded anywhere.', 'dim');
    Term.print('Ask a question about them, or run /sources to see the full corpus.', 'dim sp');
  }
  Term.scroll();
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

  const draw = ts => {
    raf = requestAnimationFrame(draw);
    if (ts - last < 55) return;                 // ~18fps: cheap, and it looks right
    last = ts;
    ctx.fillStyle = 'rgba(4,7,10,0.13)';        // trail decay
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

/* The ponytail panel carries a copy-to-clipboard button. It used to live
   in its own modal manager; now it just needs its one listener. */
function initCopyButtons() {
  $$('.copy-btn').forEach(btn => {
    const pre = btn.closest('.prompt-wrap, .ponytail-body')?.querySelector('.prompt-block');
    if (!pre) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.trim());
        const was = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(() => { btn.textContent = was; }, 1600);
      } catch (e) {
        toast('Clipboard blocked — select and copy manually.');
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
  /* Scanlines default off — they dim every glyph on the page. /crt opts in. */
  if (store.get('term.crt', false)) document.documentElement.dataset.crt = 'on';

  Modal.init();
  Term.init();
  Sec.init();
  GameModal.init();
  initContact();
  initCopyButtons();
  initUploads();
  initMatrix();

  $$('.game-tile').forEach(tile =>
    tile.addEventListener('click', () => GameModal.open(tile.dataset.game)));
  refreshBestScores();

  /* Deep links: colaco.se/#publications opens that panel on load. */
  const openFromHash = () => {
    const h = (location.hash || '').slice(1).toLowerCase();
    if (h && (COMMANDS[h] || ALIASES[h])) Term.run('/' + h, true);
  };
  addEventListener('hashchange', openFromHash);

  bootSequence().then(openFromHash);

  /* Warm the corpus in the background so the first question is fast. */
  setTimeout(() => RAG.load().catch(() => {}), 1200);
})();
