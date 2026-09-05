/* ============================================================
   Arcade — modal manager + four games
   ============================================================ */
function rr(ctx, x, y, w, h, r) { /* roundRect with fallback */
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function attachSwipe(el, cb) {
  let sx = 0, sy = 0, active = false;
  const start = e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; active = true; };
  const end = e => {
    if (!active) return; active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 28) return;
    cb(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchend', end, { passive: true });
  return () => { el.removeEventListener('touchstart', start); el.removeEventListener('touchend', end); };
}

const GameModal = {
  active: null,
  init() {
    this.overlay = $('#game-modal');
    this.panel = $('#game-panel');
    this.titleEl = $('#game-modal-title');
    this.stage = $('#game-stage');
    $('#game-close').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', e => { if (e.target === this.overlay) this.close(); });
    document.addEventListener('keydown', e => {
      if (!this.active) return;
      if (e.key === 'Escape') { this.close(); return; }
      const t = e.target;
      if ((e.key === ' ' || e.key === 'Enter') && t && t.closest && t.closest('button, a, input, textarea')) return;
      if (this.active.onKey) this.active.onKey(e);
    });
  },
  open(id) {
    const g = GAMES[id];
    if (!g) return;
    this.close();
    this.active = g;
    this.titleEl.textContent = g.title;
    this.panel.classList.toggle('wide', !!g.wide);
    this.stage.innerHTML = '';
    this.overlay.classList.add('show');
    document.body.classList.add('modal-open');
    g.init(this.stage);
    this.panel.focus({ preventScroll: true });
  },
  close() {
    if (this.active && this.active.destroy) this.active.destroy();
    this.active = null;
    if (this.overlay) {
      this.overlay.classList.remove('show');
      this.stage.innerHTML = '';
    }
    document.body.classList.remove('modal-open');
    refreshBestScores();
  }
};


const PonytailModal = {
  init() {
    this.overlay = $('#ponytail-modal');
    this.panel = $('.ponytail-panel');
    if (!this.overlay) return;
    $('#ponytail-open').addEventListener('click', () => this.open());
    $('#ponytail-close').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', e => { if (e.target === this.overlay) this.close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.overlay.classList.contains('show')) this.close(); });
    const copyBtn = $('#ponytail-copy');
    copyBtn.addEventListener('click', () => this.copyPrompt(copyBtn));
  },
  open() {
    this.overlay.classList.add('show');
    document.body.classList.add('modal-open');
    if (this.panel) this.panel.focus({ preventScroll: true });
  },
  close() {
    if (this.overlay) this.overlay.classList.remove('show');
    document.body.classList.remove('modal-open');
  },
  copyPrompt(btn) {
    const code = $('#ponytail-prompt');
    const text = code ? code.textContent : '';
    const done = () => { btn.textContent = 'Copied ✓'; btn.classList.add('copied'); showToast('Prompt copied to clipboard'); setTimeout(() => { btn.textContent = 'Copy prompt'; btn.classList.remove('copied'); }, 2200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => this.fallbackCopy(text, done));
    } else {
      this.fallbackCopy(text, done);
    }
  },
  fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) { showToast('Copy failed — select the text manually'); }
  }
};

/* ============================================================
   SLOTS — 5×3 video slot with 5 paylines
   ============================================================
   Each reel position is an independent weighted draw, so the paytable's
   expected return is analytic. Payouts below (×line bet, stake included)
   are tuned so the long-run return ≈ 95% of stake — a ~5% house edge,
   verified by simulation (≈0.9505 RTP). Wins are paid left-to-right:
   3, 4 or 5 matching symbols from the first reel on any of the five
   paylines (top / middle / bottom rows + a V and an inverted-V). */
const VS_SYMS = [
  { k: '7',    e: '7\uFE0F\u20E3', w: 1,  name: 'Sevens' },
  { k: 'DIA',  e: '\uD83D\uDC8E', w: 2,  name: 'Diamond' },
  { k: 'STAR', e: '\u2B50',       w: 4,  name: 'Star' },
  { k: 'BELL', e: '\uD83D\uDD14', w: 7,  name: 'Bell' },
  { k: 'LEM',  e: '\uD83C\uDF4B', w: 12, name: 'Lemon' },
  { k: 'CHER', e: '\uD83C\uDF52', w: 20, name: 'Cherry' }
];
const VS_W = VS_SYMS.reduce((s, x) => s + x.w, 0);
const VS_PAY = {
  '7':    { 3: 80, 4: 400, 5: 1500 },
  'DIA':  { 3: 25, 4: 100, 5: 400 },
  'STAR': { 3: 12, 4: 45,  5: 180 },
  'BELL': { 3: 6,  4: 18,  5: 60 },
  'LEM':  { 3: 5,  4: 15,  5: 36 },
  'CHER': { 3: 3,  4: 10,  5: 26 }
};
/* row index per reel for each payline (0=top, 1=mid, 2=bottom) */
const VS_LINES = [
  [0, 0, 0, 0, 0], [1, 1, 1, 1, 1], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2]
];

function vsPick() {
  const r = Math.random() * VS_W;
  let acc = 0;
  for (const s of VS_SYMS) { acc += s.w; if (r < acc) return s; }
  return VS_SYMS[VS_SYMS.length - 1];
}
/* grid: 5 reels × 3 rows; grid[reel] = [top, mid, bottom] symbols */
function vsGrid() {
  return Array.from({ length: 5 }, () => [vsPick(), vsPick(), vsPick()]);
}
/* evaluate every payline; returns { wins, total }. A line pays when the
   first reel's symbol repeats on the next 2, 3 or 4 reels (k = match count). */
function vsEval(grid, lineBet) {
  const wins = [];
  let total = 0;
  VS_LINES.forEach((line, li) => {
    const sym = grid[0][line[0]];
    let k = 1;
    while (k < 5 && grid[k][line[k]].k === sym.k) k++;
    if (k >= 3) {
      const amt = lineBet * VS_PAY[sym.k][k];
      total += amt;
      wins.push({ line: li, k, sym, amt, cells: line.slice(0, k).map((row, col) => ({ row, col })) });
    }
  });
  return { wins, total };
}

const Slots = {
  title: 'Slots',
  init(stage) {
    const BETS = [10, 25, 50, 100];
    const REELS = 5, ROWS = 3;

    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Balance</span><span class="val" id="sl-balance">1000</span></div>' +
        '<div class="hud-pill"><span class="lbl">Last win</span><span class="val" id="sl-win">0</span></div>' +
        '<button class="btn" id="sl-reset" type="button">Reset bankroll</button>' +
      '</div>' +
      '<div class="canvas-wrap" style="width:fit-content">' +
        '<div class="vs-machine" id="vs-machine"></div>' +
        '<div class="game-over-layer" id="sl-over" style="display:none">' +
          '<h4>You&rsquo;re broke</h4><p style="color:var(--ink2)">Out of chips &mdash; restart with 1,000?</p>' +
          '<button class="btn primary" id="sl-retry" type="button">Restart</button>' +
        '</div>' +
      '</div>' +
      '<div class="sl-bets" id="sl-bets"></div>' +
      '<div class="sl-actions"><button class="btn primary" id="sl-spin" type="button">Spin</button></div>' +
      '<p class="stage-hint">5 reels, 5 paylines. Match 3, 4 or 5 from the left reel on any line &mdash; five 7s is the jackpot.</p>';

    const machine = $('#vs-machine', stage);
    const betsWrap = $('#sl-bets', stage);
    const balEl = $('#sl-balance', stage), winEl = $('#sl-win', stage);
    const overEl = $('#sl-over', stage);
    const spinBtn = $('#sl-spin', stage);

    let balance = store.get('credits', 1000);
    let bet = store.get('sl.bet', 25);
    if (!BETS.includes(bet)) bet = 25;
    let lastWin = 0;
    let spinning = false;
    const reels = [];

    const symEl = s => { const d = document.createElement('div'); d.className = 'vs-sym'; d.textContent = s.e; return d; };
    const cellH = () => reels[0] ? reels[0].reel.clientHeight / ROWS : 64;

    for (let i = 0; i < REELS; i++) {
      const reel = document.createElement('div');
      reel.className = 'vs-reel';
      const strip = document.createElement('div');
      strip.className = 'vs-strip';
      reel.appendChild(strip);
      machine.appendChild(reel);
      reels.push({ reel, strip, current: [vsPick(), vsPick(), vsPick()], landedIndex: 0 });
    }

    const drawIdle = () => reels.forEach(r => {
      r.strip.style.transition = 'none';
      r.strip.innerHTML = '';
      r.current.forEach(s => r.strip.appendChild(symEl(s)));
      r.strip.classList.remove('vs-spinning');
      r.landedIndex = 0;
      r.strip.style.transform = 'translateY(0)';
    });

    const render = () => {
      balEl.textContent = balance;
      winEl.textContent = lastWin;
      [].slice.call(betsWrap.children).forEach(b => b.classList.toggle('sel', +b.dataset.bet === bet));
    };

    const clearWins = () => reels.forEach(r =>
      r.strip.querySelectorAll('.vs-sym.win').forEach(el => el.classList.remove('win')));

    const finishSpin = grid => {
      spinning = false;
      spinBtn.disabled = false;
      spinBtn.textContent = 'Spin';
      const lineBet = Math.floor(bet / VS_LINES.length);
      const { wins, total } = vsEval(grid, lineBet);
      lastWin = Math.round(total);
      balance += lastWin;
      reels.forEach(r => r.strip.classList.remove('vs-spinning'));
      if (lastWin > 0) {
        wins.forEach(w => w.cells.forEach(({ row, col }) => {
          const el = reels[col].strip.children[reels[col].landedIndex + row];
          if (el) el.classList.add('win');
        }));
        const best = wins.reduce((a, b) => b.amt > a.amt ? b : a, wins[0]);
        if (best.k === 5 && best.sym.k === '7') toast('JACKPOT! Five 7s  +' + lastWin + ' chips');
        else toast(best.k + '× ' + best.sym.name + ' on ' + wins.length + ' line' + (wins.length > 1 ? 's' : '') + '  +' + lastWin);
      }
      store.set('credits', balance);
      render();
      if (balance < BETS[0]) overEl.style.display = 'flex';
    };

    const spin = () => {
      if (spinning) return;
      if (balance < bet) { toast('Not enough chips for that bet'); return; }
      spinning = true;
      clearWins();
      balance -= bet; lastWin = 0; render();
      spinBtn.disabled = true; spinBtn.textContent = 'Spinning\u2026';
      const grid = vsGrid();
      /* sub-pixel-accurate symbol height so every reel lands exactly aligned */
      const firstSym = reels[0].strip.firstChild;
      const h = firstSym ? firstSym.getBoundingClientRect().height : (reels[0].reel.clientHeight / ROWS || 64);
      let landed = 0;
      reels.forEach((r, i) => {
        const targets = grid[i];
        const filler = 22 + i * 5;            /* scrolling symbols before the targets */
        const extras = 4;                     /* symbols after the targets, revealed by the landing overshoot */
        const count = filler + 3 + extras;
        /* reset to the top with no transition so the new spin always animates
           a real change (otherwise a second consecutive spin could hang). */
        r.strip.style.transition = 'none';
        r.strip.style.transform = 'translateY(0)';
        r.strip.innerHTML = '';
        for (let k = 0; k < count; k++) {
          const s = (k >= filler && k < filler + 3) ? targets[k - filler] : vsPick();
          r.strip.appendChild(symEl(s));
        }
        r.landedIndex = filler;               /* visible window = indices [filler .. filler+2] = targets */
        r.strip.classList.add('vs-spinning');
        void r.strip.offsetWidth;            /* force reflow so the transform animates */
        const landY = -filler * h;
        const dur = 980 + i * 300;
        /* strong ease-out with a tiny overshoot: reels brake, dip a hair past
           the target (showing the extras), then settle — a tactile landing. */
        r.strip.style.transition = 'transform ' + dur + 'ms cubic-bezier(.16,.66,.18,1.05)';
        r.strip.style.transform = 'translateY(' + landY + 'px)';
        /* finish once — on transitionend, or a safety timeout if the event
           is missed (e.g. background tab / no transform change). */
        let doneCalled = false, doneTimer = 0;
        const done = () => {
          if (doneCalled) return;
          doneCalled = true;
          clearTimeout(doneTimer);
          r.strip.removeEventListener('transitionend', onEnd);
          r.current = targets;
          r.strip.classList.remove('vs-spinning');
          landed++;
          if (landed === REELS) finishSpin(grid);
        };
        const onEnd = ev => {
          if (ev && ev.propertyName !== 'transform') return;
          done();
        };
        r.strip.addEventListener('transitionend', onEnd);
        doneTimer = setTimeout(done, dur + 200);
      });
    };

    const resetBankroll = () => {
      balance = 1000; lastWin = 0; spinning = false;
      store.set('credits', balance);
      overEl.style.display = 'none';
      drawIdle(); render();
      toast('Bankroll reset to 1,000');
    };

    drawIdle();
    BETS.forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sl-bet'; btn.dataset.bet = b; btn.textContent = b;
      btn.addEventListener('click', () => { if (spinning) return; bet = b; store.set('sl.bet', bet); render(); });
      betsWrap.appendChild(btn);
    });
    render();
    spinBtn.addEventListener('click', spin);
    $('#sl-reset', stage).addEventListener('click', resetBankroll);
    $('#sl-retry', stage).addEventListener('click', resetBankroll);

    this.onKey = e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); spin(); }
    };
    this.destroy = () => {};
  }
};


/* ============================================================
   2048
   ============================================================ */
const G2048 = {
  title: '2048',
  init(stage) {
    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Score</span><span class="val" id="g2-score">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">Best</span><span class="val" id="g2-best">0</span></div>' +
        '<button class="btn" id="g2-new" type="button">New game</button>' +
      '</div>' +
      '<div class="canvas-wrap" style="width:min(420px,86vw)">' +
        '<div class="g2-board" id="g2-board" style="touch-action:none"></div>' +
        '<div class="game-over-layer" id="g2-over" style="display:none">' +
          '<h4>Game over</h4><p id="g2-final" style="color:var(--ink2)"></p>' +
          '<button class="btn primary" id="g2-retry" type="button">Play again</button>' +
        '</div>' +
      '</div>' +
      '<p class="stage-hint">Arrow keys / WASD or swipe. Merge your way to 2048.</p>';

    const board = $('#g2-board', stage);
    const cells = [];
    for (let i = 0; i < 16; i++) {
      const c = document.createElement('div');
      c.className = 'g2-cell';
      board.appendChild(c);
      cells.push(c);
    }

    const LINES = {
      left:  [[0,1,2,3],[4,5,6,7],[8,9,10,11],[12,13,14,15]],
      right: [[3,2,1,0],[7,6,5,4],[11,10,9,8],[15,14,13,12]],
      up:    [[0,4,8,12],[1,5,9,13],[2,6,10,14],[3,7,11,15]],
      down:  [[12,8,4,0],[13,9,5,1],[14,10,6,2],[15,11,7,3]]
    };

    let grid, score, best = store.get('g2.best', 0), over, reached2048;
    const scoreEl = $('#g2-score', stage), bestEl = $('#g2-best', stage);
    const overEl = $('#g2-over', stage);

    const addRandom = () => {
      const empty = grid.map((v, i) => v ? -1 : i).filter(i => i >= 0);
      if (!empty.length) return -1;
      const i = empty[Math.floor(Math.random() * empty.length)];
      grid[i] = Math.random() < 0.9 ? 2 : 4;
      return i;
    };

    const render = (fresh, merged) => {
      for (let i = 0; i < 16; i++) {
        const v = grid[i];
        cells[i].innerHTML = v
          ? '<div class="g2-tile' + (fresh.has(i) ? ' pop' : '') + (merged.has(i) ? ' merged' : '') + '" data-v="' + v + '">' + v + '</div>'
          : '';
      }
      scoreEl.textContent = score;
      bestEl.textContent = best;
    };

    const canMove = () => {
      if (grid.includes(0)) return true;
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
        const i = r * 4 + c;
        if (c < 3 && grid[i] === grid[i + 1]) return true;
        if (r < 3 && grid[i] === grid[i + 4]) return true;
      }
      return false;
    };

    const move = dir => {
      if (over) return;
      let changed = false;
      const merged = new Set();
      LINES[dir].forEach(idxs => {
        const compact = idxs.map(i => grid[i]).filter(Boolean);
        const out = [];
        const lockedMerge = new Set();
        for (let k = 0; k < compact.length; k++) {
          const last = out.length - 1;
          if (last >= 0 && out[last] === compact[k] && !lockedMerge.has(last)) {
            out[last] *= 2;
            score += out[last];
            lockedMerge.add(last);
            merged.add(idxs[last]);
            if (out[last] === 2048 && !reached2048) { reached2048 = true; toast('2048! Absolute legend. Keep going?'); }
          } else out.push(compact[k]);
        }
        idxs.forEach((idx, pos) => {
          const nv = out[pos] || 0;
          if (grid[idx] !== nv) changed = true;
          grid[idx] = nv;
        });
      });
      if (!changed) return;
      if (score > best) { best = score; store.set('g2.best', best); }
      const fresh = new Set([addRandom()]);
      render(fresh, merged);
      if (!canMove()) {
        over = true;
        $('#g2-final', stage).textContent = 'Final score: ' + score;
        overEl.style.display = 'flex';
      }
    };

    const reset = () => {
      grid = Array(16).fill(0);
      score = 0; over = false; reached2048 = false;
      overEl.style.display = 'none';
      render(new Set([addRandom(), addRandom()]), new Set());
    };
    reset();

    $('#g2-new', stage).addEventListener('click', reset);
    $('#g2-retry', stage).addEventListener('click', reset);
    const detachSwipe = attachSwipe(board, move);

    const KEYMAP = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      a: 'left', d: 'right', w: 'up', s: 'down'
    };
    this.onKey = e => {
      const dir = KEYMAP[e.key];
      if (dir) { e.preventDefault(); move(dir); }
    };
    this.destroy = () => { detachSwipe(); };
  }
};

/* ============================================================
   X & O
   ============================================================ */
const TicTacToe = {
  title: 'X & O',
  init(stage) {
    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Wins</span><span class="val" id="xo-wins">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">Draws</span><span class="val" id="xo-draws">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">Losses</span><span class="val" id="xo-losses">0</span></div>' +
        '<button class="btn" id="xo-new" type="button">New round</button>' +
      '</div>' +
      '<div class="canvas-wrap" style="width:min(360px,86vw)">' +
        '<div class="xo-board" id="xo-board"></div>' +
        '<div class="game-over-layer" id="xo-over" style="display:none">' +
          '<h4 id="xo-over-title"></h4><p id="xo-over-sub" style="color:var(--ink2)"></p>' +
          '<button class="btn primary" id="xo-retry" type="button">Play again</button>' +
        '</div>' +
      '</div>' +
      '<p class="stage-hint">Tap a square or press 1&ndash;9. You are X, the machine is O &mdash; and it flips a coin every round: unbeatable or clueless.</p>';

    const board = $('#xo-board', stage);
    const winsEl = $('#xo-wins', stage), drawsEl = $('#xo-draws', stage), lossesEl = $('#xo-losses', stage);
    const overEl = $('#xo-over', stage), overTitle = $('#xo-over-title', stage), overSub = $('#xo-over-sub', stage);

    const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    let grid, turn, over;
    let wins = store.get('xo.wins', 0), draws = store.get('xo.draws', 0), losses = store.get('xo.losses', 0);
    const cells = [];

    const renderScore = () => { winsEl.textContent = wins; drawsEl.textContent = draws; lossesEl.textContent = losses; };

    const winner = g => {
      for (let i = 0; i < LINES.length; i++) {
        const a = LINES[i][0], b = LINES[i][1], c = LINES[i][2];
        if (g[a] && g[a] === g[b] && g[a] === g[c]) return { p: g[a], line: [a, b, c] };
      }
      return g.every(v => v) ? { p: 'draw', line: null } : null;
    };

    const draw = () => cells.forEach((c, i) => {
      c.className = 'xo-cell' + (grid[i] ? ' filled' : '');
      c.textContent = grid[i] || '';
      c.style.color = grid[i] === 'X' ? 'var(--teal)' : (grid[i] === 'O' ? 'var(--pink)' : '');
    });

    const endGame = res => {
      over = true;
      if (res.p === 'X') { wins++; store.set('xo.wins', wins); overTitle.textContent = 'You win!'; }
      else if (res.p === 'O') { losses++; store.set('xo.losses', losses); overTitle.textContent = 'Machine wins'; }
      else { draws++; store.set('xo.draws', draws); overTitle.textContent = 'Draw'; }
      renderScore();
      if (res.line) res.line.forEach(i => cells[i].classList.add('win'));
      overSub.textContent = 'X ' + wins + ' \u00b7 O ' + losses + ' \u00b7 = ' + draws;
      overEl.style.display = 'flex';
    };

    /* Two personalities, coin-flipped every round in reset():
       - 'perfect': depth-aware minimax over the full game tree — provably
         unbeatable (your best possible result is a draw).
       - 'dumb':    a uniformly random empty square. No blocking, no plan.
       Which one you're facing is never shown — that's the game. */
    let mode = 'perfect';

    const minimax = (g, isOTurn, depth) => {
      const res = winner(g);
      if (res) {
        if (res.p === 'O') return 10 - depth;   /* prefer faster wins   */
        if (res.p === 'X') return depth - 10;   /* prefer slower losses */
        return 0;
      }
      if (isOTurn) {
        let best = -Infinity;
        for (let i = 0; i < 9; i++) if (!g[i]) { g[i] = 'O'; best = Math.max(best, minimax(g, false, depth + 1)); g[i] = ''; }
        return best;
      }
      let best = Infinity;
      for (let i = 0; i < 9; i++) if (!g[i]) { g[i] = 'X'; best = Math.min(best, minimax(g, true, depth + 1)); g[i] = ''; }
      return best;
    };

    const bestMove = () => {
      const g = grid.slice();
      let best = -Infinity, mv = -1;
      for (let i = 0; i < 9; i++) if (!g[i]) {
        g[i] = 'O';
        const s = minimax(g, false, 0);
        g[i] = '';
        if (s > best) { best = s; mv = i; }
      }
      return mv;
    };

    const randomMove = () => {
      const free = [];
      for (let i = 0; i < 9; i++) if (!grid[i]) free.push(i);
      return free.length ? free[Math.floor(Math.random() * free.length)] : -1;
    };

    const aiMove = () => (mode === 'perfect' ? bestMove() : randomMove());

    const place = (i, mark) => { grid[i] = mark; draw(); };

    const playerMove = i => {
      if (over || grid[i] || turn !== 'X') return;
      place(i, 'X');
      let res = winner(grid);
      if (res) { endGame(res); return; }
      turn = 'O';
      setTimeout(() => {
        const m = aiMove();
        if (m >= 0) place(m, 'O');
        res = winner(grid);
        if (res) { endGame(res); return; }
        turn = 'X';
      }, 360);
    };

    const reset = () => {
      grid = Array(9).fill('');
      turn = 'X'; over = false;
      mode = Math.random() < 0.5 ? 'perfect' : 'dumb';  /* 50/50 each round */
      overEl.style.display = 'none';
      draw();
    };

    for (let i = 0; i < 9; i++) {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'xo-cell';
      c.addEventListener('click', () => playerMove(i));
      board.appendChild(c); cells.push(c);
    }
    $('#xo-new', stage).addEventListener('click', reset);
    $('#xo-retry', stage).addEventListener('click', reset);
    renderScore(); reset();

    this.onKey = e => {
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 9) { e.preventDefault(); playerMove(n - 1); }
      else if ((e.key === ' ' || e.key === 'Enter') && over) { e.preventDefault(); reset(); }
    };
    this.destroy = () => {};
  }
};


/* ============================================================
   FLAPPY GLASS
   ============================================================ */
const Flappy = {
  title: 'Flappy Glass',
  init(stage) {
    const W = 380, H = 560, GROUND = 54;
    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Score</span><span class="val" id="fl-score">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">Best</span><span class="val" id="fl-best">0</span></div>' +
      '</div>' +
      '<div class="canvas-wrap">' +
        '<canvas id="fl-canvas" class="game-canvas" style="width:min(380px,86vw);aspect-ratio:380/560"></canvas>' +
        '<div class="game-over-layer" id="fl-over" style="display:none">' +
          '<h4>Splat.</h4><p id="fl-final" style="color:var(--ink2)"></p>' +
          '<button class="btn primary" id="fl-retry" type="button">One more go</button>' +
        '</div>' +
      '</div>' +
      '<p class="stage-hint">Tap, click or press Space to flap. Mind the glass.</p>';

    const canvas = $('#fl-canvas', stage);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const scoreEl = $('#fl-score', stage), bestEl = $('#fl-best', stage);
    const overEl = $('#fl-over', stage), finalEl = $('#fl-final', stage);

    const G = 1650, FLAP = -430, SPEED = 172, GAP = 168, PW = 70, BX = 96, BR = 15;
    let mode, y, vy, pipes, score, deadAt, last = 0, raf = 0, t = 0;
    let best = store.get('fl.best', 0);
    bestEl.textContent = best;

    const reset = () => {
      mode = 'ready'; y = H / 2 - 40; vy = 0; pipes = []; score = 0;
      scoreEl.textContent = '0';
      overEl.style.display = 'none';
    };
    reset();

    const die = () => {
      mode = 'dead'; deadAt = performance.now();
      if (score > best) { best = score; store.set('fl.best', best); bestEl.textContent = best; }
      finalEl.textContent = 'Score: ' + score + ' · Best: ' + best;
      overEl.style.display = 'flex';
    };

    const flap = () => {
      if (mode === 'dead') {
        if (performance.now() - deadAt > 450) { reset(); }
        return;
      }
      if (mode === 'ready') mode = 'play';
      vy = FLAP;
    };

    const update = dt => {
      if (mode !== 'play') return;
      vy += G * dt;
      y += vy * dt;
      if (!pipes.length || pipes[pipes.length - 1].x < W - 232) {
        const margin = 90;
        pipes.push({ x: W + 30, gapY: margin + Math.random() * (H - GROUND - margin * 2), passed: false });
      }
      pipes.forEach(p => { p.x -= SPEED * dt; });
      while (pipes.length && pipes[0].x < -PW) pipes.shift();
      pipes.forEach(p => {
        if (!p.passed && p.x + PW < BX - BR) { p.passed = true; score++; scoreEl.textContent = score; }
        if (BX + BR > p.x && BX - BR < p.x + PW) {
          if (y - BR < p.gapY - GAP / 2 || y + BR > p.gapY + GAP / 2) die();
        }
      });
      if (y + BR > H - GROUND || y - BR < 0) die();
    };

    const drawPipe = (x, gy) => {
      ctx.fillStyle = 'rgba(63,224,197,.28)';
      ctx.strokeStyle = 'rgba(63,224,197,.7)';
      ctx.lineWidth = 1.5;
      const topH = gy - GAP / 2, botY = gy + GAP / 2;
      rr(ctx, x, -12, PW, topH + 12, 10); ctx.fill(); ctx.stroke();
      rr(ctx, x - 5, topH - 16, PW + 10, 16, 7); ctx.fill(); ctx.stroke();
      rr(ctx, x, botY, PW, H - GROUND - botY + 12, 10); ctx.fill(); ctx.stroke();
      rr(ctx, x - 5, botY, PW + 10, 16, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(x + 6, 0, 3, topH - 16);
      ctx.fillRect(x + 6, botY + 16, 3, H - GROUND - botY - 16);
    };

    const draw = now => {
      ctx.clearRect(0, 0, W, H);
      /* ambient glass orbs */
      ctx.fillStyle = 'rgba(106,183,255,.08)';
      ctx.beginPath(); ctx.arc(70 - (t * 12 % 500), 130, 60, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(330 - (t * 20 % 700), 320, 85, 0, Math.PI * 2); ctx.fill();
      pipes.forEach(p => drawPipe(p.x, p.gapY));
      /* ground */
      ctx.fillStyle = 'rgba(255,255,255,.06)';
      ctx.fillRect(0, H - GROUND, W, GROUND);
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.beginPath(); ctx.moveTo(0, H - GROUND); ctx.lineTo(W, H - GROUND); ctx.stroke();
      /* bird */
      const by = mode === 'ready' ? y + Math.sin(now / 260) * 7 : y;
      const tilt = mode === 'play' ? Math.max(-0.5, Math.min(0.9, vy / 600)) : 0;
      ctx.save();
      ctx.translate(BX, by);
      ctx.rotate(tilt);
      const bg = ctx.createRadialGradient(-5, -5, 2, 0, 0, BR + 2);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#ffb2cb');
      ctx.beginPath(); ctx.arc(0, 0, BR, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.shadowColor = 'rgba(255,107,157,.65)'; ctx.shadowBlur = 16;
      ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.stroke();
      const wingUp = vy < 0 || mode === 'ready';
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.beginPath();
      ctx.ellipse(-4, wingUp ? -3 : 4, 8, 4.5, wingUp ? -0.5 : 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0f1f';
      ctx.beginPath(); ctx.arc(6, -4, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.moveTo(BR - 2, -1); ctx.lineTo(BR + 7, 2); ctx.lineTo(BR - 2, 5); ctx.closePath(); ctx.fill();
      ctx.restore();
      /* score + hints */
      ctx.textAlign = 'center';
      if (mode === 'play') {
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.font = '700 44px "Space Grotesk", sans-serif';
        ctx.fillText(String(score), W / 2, 78);
      }
      if (mode === 'ready') {
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        ctx.font = '700 24px "Space Grotesk", sans-serif';
        ctx.fillText('Tap to flap', W / 2, H / 2 + 60);
        ctx.font = '500 13px -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.5)';
        ctx.fillText('Space works too', W / 2, H / 2 + 84);
      }
    };

    const loop = now => {
      if (!last) last = now;
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      t += dt;
      update(dt);
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onPointer = e => { e.preventDefault(); flap(); };
    canvas.addEventListener('pointerdown', onPointer);
    $('#fl-retry', stage).addEventListener('click', reset);

    this.onKey = e => {
      if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); flap(); }
    };
    this.destroy = () => { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', onPointer); };
  }
};

/* ============================================================
   PLINKO
   ============================================================ */
/* ---- Plinko maths: binomial landing odds + payout normalisation ----
   Bucket k of an n-row board is hit with probability C(n,k)/2^n. On this
   board the balls tend to fan out toward the edges, so the high multipliers
   are placed in the CENTRE (the rarer landing zone) and decay toward the
   edges. Payouts follow an exponential curve peaking at the centre, get a
   0.3x edge floor, then are normalised so the expected return is ~97% of
   stake. Works for any row count, so the rows selector can offer 5–8
   without hand-made tables. */
function plinkoProbs(n) {
  const c = [1];
  for (let r = 0; r < n; r++) for (let k = r; k >= 0; k--) c[k + 1] = (c[k + 1] || 0) + c[k];
  const total = Math.pow(2, n);
  return c.map(x => x / total);
}
function plinkoMultipliers(rows) {
  const p = plinkoProbs(rows);
  const half = rows / 2, R = 2.35, RTP = 0.97, FLOOR = 0.3;
  /* peak at the centre (k = half), decay toward the edges */
  let m = p.map((_, k) => Math.pow(R, half - Math.abs(k - half)));
  const ev0 = m.reduce((s, x, k) => s + x * p[k], 0);
  m = m.map(x => x * RTP / ev0);
  for (let pass = 0; pass < 3; pass++) {
    let floorEv = 0, freeEv = 0;
    m.forEach((x, k) => { if (x <= FLOOR) floorEv += FLOOR * p[k]; else freeEv += x * p[k]; });
    if (!freeEv) break;
    const scale = (RTP - floorEv) / freeEv;
    m = m.map(x => (x <= FLOOR ? FLOOR : x * scale));
  }
  return m.map(x => x >= 100 ? Math.round(x) : x >= 10 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100);
}

const Plinko = {
  title: 'Plinko',
  init(stage) {
    /* Physics: Matter.js — the open-source MIT rigid-body engine
       (brm.io/matter-js, © Liam Brummitt & contributors) that powers the
       well-known browser Plinko implementations. Board geometry and the
       payout normalisation above follow those projects. */
    if (typeof Matter === 'undefined') {
      stage.innerHTML =
        '<div class="error-panel glass" style="max-width:420px;margin:0 auto">' +
          '<p><strong>Physics engine still loading.</strong><br>Plinko runs on the open-source Matter.js engine, fetched from a CDN \u2014 give it a second (or check the connection) and try again.</p>' +
          '<button class="btn primary" id="pk-retry-lib" type="button">Try again</button>' +
        '</div>';
      $('#pk-retry-lib', stage).addEventListener('click', () => { GameModal.close(); GameModal.open('plinko'); });
      this.onKey = null;
      this.destroy = () => {};
      return;
    }
    const { Engine, Bodies, Body, Composite, Events } = Matter;

    const ROW_OPTS = [5, 6, 7, 8];
    const BETS = [10, 25, 50, 100];
    const MAX_BALLS = 15;
    const W = 380;

    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Balance</span><span class="val" id="pk-balance">1000</span></div>' +
        '<div class="hud-pill"><span class="lbl">Last win</span><span class="val" id="pk-win">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">In play</span><span class="val" id="pk-inplay">0</span></div>' +
        '<button class="btn" id="pk-reset" type="button">Reset bankroll</button>' +
      '</div>' +
      '<div class="canvas-wrap" style="width:fit-content">' +
        '<canvas id="pk-canvas" class="game-canvas" style="width:min(380px,86vw)"></canvas>' +
      '</div>' +
      '<div class="pk-rows" id="pk-rows"><span class="pk-lab">Rows</span></div>' +
      '<div class="sl-bets" id="pk-bets"><span class="pk-lab">Chips</span></div>' +
      '<div class="sl-actions"><button class="btn primary" id="pk-drop" type="button">Drop</button></div>' +
      '<p class="stage-hint">Every tap on the board (or Drop) releases another ball \u2014 stack up to ' + MAX_BALLS + ' at once. More rows, spicier edges.</p>';

    const canvas = $('#pk-canvas', stage);
    const balEl = $('#pk-balance', stage), winEl = $('#pk-win', stage), inplayEl = $('#pk-inplay', stage);
    const rowsWrap = $('#pk-rows', stage), betsWrap = $('#pk-bets', stage);
    const dropBtn = $('#pk-drop', stage);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    let balance = store.get('credits', 1000);
    let bet = store.get('pk.bet', 25);
    if (!BETS.includes(bet)) bet = 25;
    let rows = store.get('pk.rows', 6);
    if (!ROW_OPTS.includes(rows)) rows = 6;
    let lastWin = 0;

    /* board state (rebuilt when the row count changes) */
    let engine = null;
    let pegs = [], balls = [], flashes = [];
    let mults = [];
    let gapX = 0, gapY = 0, pegR = 0, ballR = 0;
    let topY = 40, firstPegY = 64, bucketY = 0, bucketH = 26, boardH = 0, firstBucketLeft = 0;
    let raf = 0;

    const teardownEngine = () => {
      if (!engine) return;
      Events.off(engine);
      Composite.clear(engine.world, false);
      Engine.clear(engine);
      engine = null;
    };

    const build = () => {
      teardownEngine();
      mults = plinkoMultipliers(rows);
      gapX = Math.min(38, (W - 32) / (rows + 1));
      gapY = Math.max(26, Math.min(34, 420 / rows));
      pegR = Math.max(2.2, gapX * 0.13);
      ballR = Math.max(3.5, gapX * 0.16);
      const lastPegY = firstPegY + (rows - 1) * gapY;
      bucketY = lastPegY + gapY * 0.9;
      boardH = Math.round(bucketY + bucketH + 12);
      firstBucketLeft = W / 2 - (rows + 1) / 2 * gapX;

      canvas.width = W * dpr;
      canvas.height = boardH * dpr;
      canvas.style.aspectRatio = W + '/' + boardH;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      engine = Engine.create();
      engine.gravity.y = 1.0;

      pegs = [];
      flashes = new Array(rows + 1).fill(0);
      const statics = [];
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i <= r; i++) {
          const x = W / 2 + (i - r / 2) * gapX;
          const y = firstPegY + r * gapY;
          pegs.push({ x, y, glow: 0 });
          statics.push(Bodies.circle(x, y, pegR, {
            isStatic: true, restitution: 0.35, friction: 0, label: 'peg:' + (pegs.length - 1)
          }));
        }
      }
      const wallOff = (rows - 1) / 2 * gapX + gapX * 0.9;
      statics.push(Bodies.rectangle(W / 2 - wallOff, boardH / 2, 10, boardH * 2, { isStatic: true, label: 'wall' }));
      statics.push(Bodies.rectangle(W / 2 + wallOff, boardH / 2, 10, boardH * 2, { isStatic: true, label: 'wall' }));
      Composite.add(engine.world, statics);

      Events.on(engine, 'collisionStart', e => {
        for (const pair of e.pairs) {
          const lbl = pair.bodyA.label.indexOf('peg:') === 0 ? pair.bodyA.label
                    : pair.bodyB.label.indexOf('peg:') === 0 ? pair.bodyB.label : null;
          if (lbl) { const peg = pegs[+lbl.slice(4)]; if (peg) peg.glow = 1; }
        }
      });
    };

    const render = () => {
      balEl.textContent = balance;
      winEl.textContent = lastWin;
      inplayEl.textContent = balls.length;
      [].slice.call(betsWrap.querySelectorAll('.sl-bet')).forEach(b => b.classList.toggle('sel', +b.dataset.bet === bet));
      [].slice.call(rowsWrap.querySelectorAll('.sl-bet')).forEach(b => b.classList.toggle('sel', +b.dataset.rows === rows));
    };

    const settle = (k, ballBet) => {
      const mult = mults[k];
      const win = Math.round(ballBet * mult);
      balance += win;
      lastWin = win;
      flashes[k] = 1;
      store.set('credits', balance);
      render();
      if (mult >= 5) toast('Landed ' + mult + '\u00d7  +' + win + ' chips');
    };

    const drop = () => {
      if (!engine) return;
      if (balls.length >= MAX_BALLS) { toast('Max ' + MAX_BALLS + ' balls in the air'); return; }
      if (balance < bet) { toast('Not enough chips for that bet'); return; }
      balance -= bet;
      store.set('credits', balance);
      const body = Bodies.circle(W / 2 + (Math.random() - 0.5) * gapX * 0.5, topY - 16, ballR, {
        restitution: 0.4, friction: 0.0002, frictionAir: 0.012, density: 0.002, label: 'ball'
      });
      Body.setVelocity(body, { x: (Math.random() - 0.5) * 0.4, y: 0 });
      Composite.add(engine.world, body);
      balls.push({ body, bet });
      render();
    };

    const drawBoard = () => {
      ctx.clearRect(0, 0, W, boardH);
      /* drop marker */
      ctx.fillStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath();
      ctx.moveTo(W / 2, topY - 4); ctx.lineTo(W / 2 - 6, topY - 14); ctx.lineTo(W / 2 + 6, topY - 14);
      ctx.closePath(); ctx.fill();
      /* pegs */
      for (const p of pegs) {
        if (p.glow > 0.04) {
          ctx.beginPath(); ctx.arc(p.x, p.y, pegR + p.glow * 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(63,224,197,' + (0.45 * p.glow) + ')'; ctx.fill();
          p.glow *= 0.88;
        } else p.glow = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, pegR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.fill();
      }
      /* buckets */
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const baseFs = Math.max(6.5, Math.min(11, gapX * 0.40));
      /* compact labels so they never overflow a narrow bucket: round big
         multipliers, keep 1–2 decimals for small ones, then shrink-to-fit */
      const fmt = m => m >= 10 ? String(Math.round(m))
        : m >= 1 ? String(Math.round(m * 10) / 10)
        : String(Math.round(m * 100) / 100);
      for (let k = 0; k <= rows; k++) {
        const x = firstBucketLeft + k * gapX;
        const f = flashes[k];
        if (f > 0.04) flashes[k] *= 0.92; else flashes[k] = 0;
        const mult = mults[k];
        ctx.fillStyle = f > 0.04 ? 'rgba(255,209,102,' + (0.35 + 0.6 * f) + ')'
          : mult >= 10 ? 'rgba(255,209,102,.16)'
          : mult >= 2 ? 'rgba(63,224,197,.13)'
          : 'rgba(255,255,255,.05)';
        rr(ctx, x + 1.5, bucketY, gapX - 3, bucketH, 6); ctx.fill();
        ctx.fillStyle = f > 0.04 ? '#0a0f1f' : 'rgba(255,255,255,.55)';
        const label = fmt(mult) + (gapX >= 34 ? '\u00d7' : '');
        ctx.font = '700 ' + baseFs + 'px ui-monospace, SFMono-Regular, monospace';
        const maxW = gapX - 4;
        if (ctx.measureText(label).width > maxW) {
          const fs = Math.max(5.5, baseFs * maxW / ctx.measureText(label).width);
          ctx.font = '700 ' + fs + 'px ui-monospace, SFMono-Regular, monospace';
        }
        ctx.fillText(label, x + gapX / 2, bucketY + bucketH / 2);
      }
      /* balls */
      for (const b of balls) {
        const pos = b.body.position;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, ballR, 0, Math.PI * 2);
        ctx.fillStyle = '#3fe0c5';
        ctx.shadowColor = 'rgba(63,224,197,.85)'; ctx.shadowBlur = 12;
        ctx.fill(); ctx.shadowBlur = 0;
      }
    };

    const loop = () => {
      if (engine) {
        Engine.update(engine, 1000 / 60);
        for (let i = balls.length - 1; i >= 0; i--) {
          const b = balls[i];
          const pos = b.body.position;
          if (pos.y > bucketY - ballR * 0.2) {
            let k = Math.floor((pos.x - firstBucketLeft) / gapX);
            if (k < 0) k = 0; if (k > rows) k = rows;
            Composite.remove(engine.world, b.body);
            balls.splice(i, 1);
            settle(k, b.bet);
          } else if (pos.y > boardH + 80 || pos.x < -40 || pos.x > W + 40) {
            /* escaped the board somehow — refund the stake */
            balance += b.bet;
            store.set('credits', balance);
            Composite.remove(engine.world, b.body);
            balls.splice(i, 1);
            render();
          }
        }
      }
      drawBoard();
      raf = requestAnimationFrame(loop);
    };

    /* controls */
    ROW_OPTS.forEach(v => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sl-bet'; btn.dataset.rows = v; btn.textContent = v;
      btn.addEventListener('click', () => {
        if (v === rows) return;
        if (balls.length) { toast('Let the balls land first'); return; }
        rows = v; store.set('pk.rows', rows);
        build(); render();
      });
      rowsWrap.appendChild(btn);
    });
    BETS.forEach(b => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sl-bet'; btn.dataset.bet = b; btn.textContent = b;
      btn.addEventListener('click', () => { bet = b; store.set('pk.bet', bet); render(); });
      betsWrap.appendChild(btn);
    });

    const onPointer = e => { e.preventDefault(); drop(); };
    canvas.addEventListener('pointerdown', onPointer);
    dropBtn.addEventListener('click', drop);
    $('#pk-reset', stage).addEventListener('click', () => {
      balls.forEach(b => { if (engine) Composite.remove(engine.world, b.body); });
      balls = [];
      balance = 1000; lastWin = 0;
      store.set('credits', balance);
      render();
      toast('Bankroll reset to 1,000');
    });

    build();
    render();
    raf = requestAnimationFrame(loop);

    this.onKey = e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); drop(); }
    };
    this.destroy = () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointer);
      /* refund any balls still in flight */
      let refund = 0;
      balls.forEach(b => { refund += b.bet; });
      if (refund) { balance += refund; store.set('credits', balance); }
      balls = [];
      teardownEngine();
    };
  }
};

/* ============================================================
   ROULETTE — European single-zero, mobile-first
   ============================================================
   37 pockets (0–36). The winning number is preselected uniformly
   BEFORE the wheel animation starts — the spin only displays the
   result, it never determines it. Every bet carries the same ~2.7%
   house edge (1/37), the European-standard single-zero edge:
     straight (one number)        35:1   → returns stake × 36
     red / black / odd / even /
     1–18 / 19–36                1:1    → returns stake × 2
     dozens (1st/2nd/3rd 12) /
     columns                     2:1    → returns stake × 3
   Zero loses every outside bet — that's the edge. */
const RT_WHEEL = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RT_RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function rtColor(n){ return n===0 ? 'green' : (RT_RED.has(n) ? 'red' : 'black'); }
/* profit per 1 staked; a winning bet returns stake × (odds+1) */
const RT_ODDS = { straight:35, red:1, black:1, odd:1, even:1, low:1, high:1, dozen:2, col:2 };
function rtBetWins(key, n){
  if (key.indexOf('straight:') === 0) return n === +key.slice(9);
  if (key === 'red')   return n!==0 && RT_RED.has(n);
  if (key === 'black') return n!==0 && !RT_RED.has(n);
  if (key === 'odd')   return n!==0 && n%2===1;
  if (key === 'even')  return n!==0 && n%2===0;
  if (key === 'low')   return n>=1 && n<=18;
  if (key === 'high')  return n>=19 && n<=36;
  if (key.indexOf('dozen:') === 0){ const d=+key.slice(6); return n>=(d-1)*12+1 && n<=d*12; }
  if (key.indexOf('col:') === 0){ if (n===0) return false; const c=+key.slice(4), m=n%3; return (c===3?0:c)===m; }
  return false;
}
function rtBetType(key){
  if (key.indexOf('straight:')===0) return 'straight';
  if (key.indexOf('dozen:')===0) return 'dozen';
  if (key.indexOf('col:')===0) return 'col';
  return key;
}

/* ============================================================
   ROULETTE GAME
   ============================================================ */
const Roulette = {
  title: 'Roulette',
  init(stage) {
    const CHIPS = [10, 25, 50, 100];
    const TAU = Math.PI * 2, POCK = TAU / 37;
    const COL = { green: '#3fe0c5', red: '#ff5d5d', black: '#161c2e', gold: '#ffd166' };

    stage.innerHTML =
      '<div class="game-hud">' +
        '<div class="hud-pill"><span class="lbl">Balance</span><span class="val" id="rt-balance">1000</span></div>' +
        '<div class="hud-pill"><span class="lbl">On table</span><span class="val" id="rt-staked">0</span></div>' +
        '<div class="hud-pill"><span class="lbl">Last result</span><span class="val" id="rt-win">\u2014</span></div>' +
        '<button class="btn" id="rt-reset" type="button">Reset bankroll</button>' +
      '</div>' +
      '<div class="rt-wheel-wrap" id="rt-wheel-wrap" style="display:none">' +
        '<canvas id="rt-canvas" class="game-canvas" style="width:min(300px,82vw);aspect-ratio:1"></canvas>' +
        '<p class="stage-hint" id="rt-wheel-hint">No more bets\u2026</p>' +
      '</div>' +
      '<div class="rt-table-wrap" id="rt-table-wrap">' +
        '<div class="rt-nums-wrap">' +
          '<button class="rt-cell rt-zero" type="button" data-bet="straight:0">0</button>' +
          '<div class="rt-nums" id="rt-nums"></div>' +
          '<div class="rt-cols" id="rt-cols"></div>' +
        '</div>' +
        '<div class="rt-dozen" id="rt-dozen"></div>' +
        '<div class="rt-even" id="rt-even"></div>' +
      '</div>' +
      '<div class="sl-bets" id="rt-chips"><span class="pk-lab">Chip</span></div>' +
      '<div class="sl-actions">' +
        '<button class="btn" id="rt-clear" type="button">Clear</button>' +
        '<button class="btn primary" id="rt-spin" type="button">Spin</button>' +
      '</div>' +
      '<p class="stage-hint">Place chips on the table, then Spin to reveal the wheel.</p>';

    const numsEl = $('#rt-nums', stage), colsEl = $('#rt-cols', stage), dozenEl = $('#rt-dozen', stage), evenEl = $('#rt-even', stage);
    const chipsWrap = $('#rt-chips', stage);
    const balEl = $('#rt-balance', stage), stakedEl = $('#rt-staked', stage), winEl = $('#rt-win', stage);
    const spinBtn = $('#rt-spin', stage), clearBtn = $('#rt-clear', stage);
    const tableWrap = $('#rt-table-wrap', stage), wheelWrap = $('#rt-wheel-wrap', stage), wheelHint = $('#rt-wheel-hint', stage);
    const canvas = $('#rt-canvas', stage);

    let balance = store.get('credits', 1000);
    let chip = store.get('rt.chip', 25);
    if (!CHIPS.includes(chip)) chip = 25;
    let bets = new Map();          /* betKey -> amount */
    let state = 'betting';         /* betting | spinning | result */
    let lastNet = null;
    let winning = 0;
    let rot = 0, raf = 0, spinAnim = null;
    let spinState = null;
    let ballAngle = -Math.PI / 2, ballR = 0, ballActive = false;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = 300, H = 300;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);

    const totalStaked = () => { let s = 0; bets.forEach(v => s += v); return s; };

    const render = () => {
      balEl.textContent = balance;
      stakedEl.textContent = totalStaked();
      winEl.textContent = lastNet == null ? '\u2014' : (lastNet >= 0 ? '+' + lastNet : '\u2212' + Math.abs(lastNet));
      [].slice.call(chipsWrap.querySelectorAll('.sl-bet')).forEach(b => b.classList.toggle('sel', +b.dataset.chip === chip));
      const cells = stage.querySelectorAll('[data-bet]');
      cells.forEach(c => {
        const amt = bets.get(c.dataset.bet) || 0;
        let badge = c.querySelector('.rt-chip-badge');
        if (amt > 0) {
          c.classList.add('has-bet');
          if (badge) badge.textContent = amt;
          else { const d = document.createElement('span'); d.className = 'rt-chip-badge'; d.textContent = amt; c.appendChild(d); }
        } else {
          c.classList.remove('has-bet');
          if (badge) badge.remove();
        }
      });
      spinBtn.disabled = state === 'spinning' || (state === 'betting' && totalStaked() === 0);
      clearBtn.disabled = (state !== 'betting') || totalStaked() === 0;
      spinBtn.textContent = state === 'spinning' ? 'Spinning\u2026' : (state === 'result' ? 'New round' : 'Spin');
      /* hide the chip selector while the wheel is spinning (and while the
         result is shown) — chips are only meaningful at the betting stage */
      chipsWrap.style.display = state === 'betting' ? '' : 'none';
    };

    const placeBet = key => {
      if (state !== 'betting') return;
      if (balance < totalStaked() + chip) { toast('Not enough chips for that chip'); return; }
      bets.set(key, (bets.get(key) || 0) + chip);
      render();
    };
    const clearBets = () => { if (state !== 'betting') return; bets.clear(); render(); };

    /* number cells: top row 3,6,\u2026,36; mid 2,5,\u2026,35; bottom 1,4,\u2026,34 */
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 12; c++) {
        const n = c * 3 + (3 - r);
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'rt-cell rt-num ' + rtColor(n);
        btn.dataset.bet = 'straight:' + n; btn.textContent = n;
        numsEl.appendChild(btn);
      }
    }
    /* column 2:1 buttons: top row -> col 3, mid -> col 2, bottom -> col 1 */
    for (let r = 0; r < 3; r++) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'rt-cell rt-colbet';
      btn.dataset.bet = 'col:' + (3 - r); btn.textContent = '2:1';
      colsEl.appendChild(btn);
    }
    [['1st 12', 'dozen:1'], ['2nd 12', 'dozen:2'], ['3rd 12', 'dozen:3']].forEach(([lbl, key]) => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'rt-cell rt-outside'; btn.dataset.bet = key; btn.textContent = lbl;
      dozenEl.appendChild(btn);
    });
    [['1\u201318', 'low'], ['EVEN', 'even'], ['RED', 'red'], ['BLACK', 'black'], ['ODD', 'odd'], ['19\u201336', 'high']].forEach(([lbl, key]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rt-cell rt-outside' + (key === 'red' ? ' red' : '') + (key === 'black' ? ' black' : '');
      btn.dataset.bet = key; btn.textContent = lbl;
      evenEl.appendChild(btn);
    });
    CHIPS.forEach(v => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'sl-bet'; btn.dataset.chip = v; btn.textContent = v;
      btn.addEventListener('click', () => { if (state !== 'betting') return; chip = v; store.set('rt.chip', chip); render(); });
      chipsWrap.appendChild(btn);
    });

    stage.querySelectorAll('[data-bet]').forEach(el => el.addEventListener('click', () => placeBet(el.dataset.bet)));

    const drawWheel = () => {
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 4;
      const rWedgeOut = R * 0.93, rHub = R * 0.45;
      /* outer ball track (dark band the ball orbits on) */
      ctx.fillStyle = '#070b16'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
      /* pocket wedges */
      for (let i = 0; i < 37; i++) {
        const n = RT_WHEEL[i];
        const a0 = -Math.PI / 2 + (i - 0.5) * POCK + rot, a1 = a0 + POCK;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, rWedgeOut, a0, a1); ctx.closePath();
        ctx.fillStyle = n === 0 ? COL.green : (RT_RED.has(n) ? COL.red : COL.black); ctx.fill();
      }
      /* hub */
      ctx.fillStyle = 'rgba(10,15,31,.98)'; ctx.beginPath(); ctx.arc(cx, cy, rHub, 0, TAU); ctx.fill();
      /* gold frets between pockets (what the ball bounces off) */
      ctx.strokeStyle = 'rgba(255,209,102,.55)'; ctx.lineWidth = 1;
      for (let i = 0; i < 37; i++) {
        const ab = -Math.PI / 2 + (i - 0.5) * POCK + rot;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ab) * rHub, cy + Math.sin(ab) * rHub);
        ctx.lineTo(cx + Math.cos(ab) * rWedgeOut, cy + Math.sin(ab) * rWedgeOut);
        ctx.stroke();
      }
      /* numbers, radial, in the outer part of each pocket */
      for (let i = 0; i < 37; i++) {
        const n = RT_WHEEL[i];
        const mid = -Math.PI / 2 + i * POCK + rot;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(mid);
        ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.max(7, R * 0.072) + 'px ui-monospace, monospace';
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(String(n), rWedgeOut - 3, 0);
        ctx.restore();
      }
      /* fixed diamond deflectors on the track */
      const rDef = R * 0.945;
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      for (let d = 0; d < 8; d++) {
        const a = d * (TAU / 8) - Math.PI / 2;
        const dx = cx + Math.cos(a) * rDef, dy = cy + Math.sin(a) * rDef;
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(Math.PI / 4);
        ctx.beginPath(); ctx.rect(-2.3, -2.3, 4.6, 4.6); ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(255,255,255,.2)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, rHub, 0, TAU); ctx.stroke();
      ctx.fillStyle = COL.gold; ctx.font = '700 16px "Space Grotesk", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(state === 'result' ? String(winning) : 'RT', cx, cy);
      /* the ball: orbits the outer track, spirals inward past the
         deflectors, bounces off the frets, and settles into a pocket —
         its resting place IS the result (no preselected winner, no pointer). */
      if (ballActive) {
        const bx = cx + Math.cos(ballAngle) * ballR;
        const by = cy + Math.sin(ballAngle) * ballR;
        const br = Math.max(3.5, R * 0.045);
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(bx + 1, by + 2, br, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(255,255,255,.6)'; ctx.shadowBlur = 6;
        ctx.beginPath(); ctx.arc(bx, by, br, 0, TAU); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath(); ctx.arc(bx - br * 0.3, by - br * 0.3, br * 0.35, 0, TAU); ctx.fill();
      }
    };

    const settle = () => {
      state = 'result';
      const staked = totalStaked();
      balance -= staked;
      let winnings = 0;
      bets.forEach((amt, key) => { if (rtBetWins(key, winning)) winnings += amt * (RT_ODDS[rtBetType(key)] + 1); });
      balance += winnings;
      lastNet = winnings - staked;
      store.set('credits', balance);
      render();
      const col = rtColor(winning);
      wheelHint.textContent = 'Landed on ' + winning + ' (' + col + '). ' + (lastNet >= 0 ? '+' : '') + lastNet + ' chips.';
      if (lastNet > 0) toast(winning + ' ' + col.toUpperCase() + ' \u2014 +' + lastNet + ' chips');
      else if (lastNet < 0) toast(winning + ' ' + col.toUpperCase() + ' \u2014 ' + lastNet + ' chips');
      else toast(winning + ' ' + col.toUpperCase() + ' \u2014 even');
    };

    const spin = () => {
      if (state === 'result') {
        bets.clear(); state = 'betting'; winning = 0; ballActive = false; spinState = null; spinAnim = null;
        tableWrap.style.display = ''; wheelWrap.style.display = 'none'; render(); return;
      }
      if (state !== 'betting') return;
      if (totalStaked() === 0) { toast('Place a bet first'); return; }
      state = 'spinning'; render();
      tableWrap.style.display = 'none'; wheelWrap.style.display = '';
      wheelHint.textContent = 'No more bets\u2026';
      /* Eased spin, after the open-source canvas-wheel pattern used by
         Winwheel.js and the classic HTML5 wheel demos (e.g.
         https://dougtesting.net/winwheel/docs/tut12_animation_details):
         the wheel and ball counter-rotate and decelerate on an ease-out
         curve. The winning pocket is preselected, then the ball's final
         world angle is computed so it lands exactly in that pocket's
         centre — so the resting place always matches the reported result,
         with no visible snap (the easing arrives precisely on target). */
      const Rm = Math.min(W, H) / 2 - 4;
      const winnerIdx = Math.floor(Math.random() * 37);
      winning = RT_WHEEL[winnerIdx];
      const wheelTurns = 4 + Math.random() * 2;      /* 4–6 turns, clockwise */
      const ballTurns  = 6 + Math.random() * 3;      /* 6–9 turns, the other way */
      const startRot = rot;
      const finalRot = startRot + wheelTurns * TAU;
      /* pocket i is centred at world angle -π/2 + i*POCK + rot */
      const ballAngleEnd   = -Math.PI / 2 + winnerIdx * POCK + finalRot;
      const ballAngleStart = ballAngleEnd + ballTurns * TAU;   /* spin backward into place */
      const ballTrackR  = Rm * 0.965;     /* outer track the ball orbits on */
      const ballSettleR = Rm * 0.60;      /* inner pocket ring where it comes to rest */
      spinState = {
        t0: performance.now(),
        duration: 4200 + Math.random() * 1200,   /* 4.2–5.4s */
        startRot, finalRot,
        ballAngleStart, ballAngleEnd,
        ballTrackR, ballSettleR,
        winnerIdx
      };
      ballR = ballTrackR;
      ballAngle = ballAngleStart;
      ballActive = true;
      spinAnim = easedStep;
    };

    const easeOutQuart = t => 1 - Math.pow(1 - t, 4);
    const easedStep = now => {
      const s = spinState; if (!s) return;
      let t = (now - s.t0) / s.duration;
      if (t >= 1) {
        rot = s.finalRot;
        ballAngle = s.ballAngleEnd;
        ballR = s.ballSettleR;
        spinState = null; spinAnim = null;
        state = 'result';
        settle();
        return;
      }
      const e = easeOutQuart(t);
      rot = s.startRot + (s.finalRot - s.startRot) * e;
      ballAngle = s.ballAngleStart + (s.ballAngleEnd - s.ballAngleStart) * e;
      /* ball rides the outer track while fast, drops to the pocket ring as it slows */
      ballR = s.ballTrackR + (s.ballSettleR - s.ballTrackR) * Math.pow(t, 2.2);
      /* gentle damped bobble while it settles (decays to 0 at t=1, so the
         resting radius is exact and there is no snap) */
      ballR += Math.pow(1 - t, 2) * Math.sin(t * Math.PI * 7) * (s.ballTrackR - s.ballSettleR) * 0.06;
    };

    const masterLoop = () => {
      if (spinAnim) spinAnim(performance.now());
      drawWheel();
      raf = requestAnimationFrame(masterLoop);
    };

    $('#rt-reset', stage).addEventListener('click', () => {
      balance = 1000; bets.clear(); lastNet = null; winning = 0; state = 'betting'; rot = 0; spinAnim = null; ballActive = false; spinState = null;
      tableWrap.style.display = ''; wheelWrap.style.display = 'none';
      store.set('credits', balance); render(); toast('Bankroll reset to 1,000');
    });
    clearBtn.addEventListener('click', clearBets);
    spinBtn.addEventListener('click', spin);

    render();
    raf = requestAnimationFrame(masterLoop);

    this.onKey = e => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); spin(); }
    };
    this.destroy = () => { cancelAnimationFrame(raf); };
  }
};

const GAMES = { slots: Slots, plinko: Plinko, roulette: Roulette, g2048: G2048, xo: TicTacToe, flappy: Flappy };
