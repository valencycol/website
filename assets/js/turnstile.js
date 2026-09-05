/* ============================================================
   Turnstile boot gate

   The assistant answers general questions now, which makes its endpoint
   worth abusing: without a gate it is a free LLM on someone else's Groq
   quota. So a visitor solves one Turnstile challenge at page load and
   receives a short-lived signed pass, which every later question carries.

   A Turnstile token is single-use — it cannot be attached to each
   message — which is exactly why the pass exists.

   Verification runs behind the boot animation, so for the overwhelming
   majority of visitors (managed mode resolves invisibly) the gate is
   never seen: the terminal simply finishes booting.
   ============================================================ */

const TURNSTILE_SITEKEY = '0x4AAAAAAEpV1tSB4MirgOlN';
const VERIFY_ENDPOINT   = 'https://chat.colaco.se/verify';
const PASS_KEY          = 'term.pass';

/* How long the boot screen will wait on Turnstile before getting out of the
   way. Managed mode clears in ~1s in a real browser; this is the budget for
   everything else. */
const BOOT_DEADLINE_MS  = 4500;

const Gate = {
  pass: '',
  ready: false,

  /* The stored pass carries its own expiry, so a returning visitor inside
     the window is not challenged again. */
  restore() {
    const saved = store.get(PASS_KEY, null);
    if (saved && saved.pass && saved.exp > Date.now() / 1000 + 60) {
      this.pass = saved.pass;
      this.ready = true;
      return true;
    }
    return false;
  },

  save(pass, ttl) {
    this.pass = pass;
    this.ready = true;
    store.set(PASS_KEY, { pass, exp: Math.floor(Date.now() / 1000) + (ttl || 43200) });
  },

  clear() {
    this.pass = '';
    this.ready = false;
    store.set(PASS_KEY, null);
  },

  /* Load the Turnstile script and render an invisible widget. Resolves with
     a token, or rejects if the script is blocked or the challenge fails. */
  challenge() {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); fn(v); };
      const timer = setTimeout(() => reject(new Error('challenge timed out')), 25000);

      const render = () => {
        try {
          window.turnstile.render('#ts-widget', {
            sitekey: TURNSTILE_SITEKEY,
            action: 'chat',
            appearance: 'interaction-only',   // shows itself only if it must
            callback: t => done(resolve, t),
            'error-callback': () => done(reject, new Error('challenge failed')),
            'timeout-callback': () => done(reject, new Error('challenge expired')),
          });
        } catch (e) { done(reject, e); }
      };

      if (window.turnstile && window.turnstile.render) return render();

      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      sc.defer = true;
      sc.onload = render;
      sc.onerror = () => done(reject, new Error('Turnstile script blocked'));
      document.head.appendChild(sc);
    });
  },

  /* Exchange a token for a pass. */
  async verify(token) {
    const res = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('verify failed (' + res.status + ')'));
    if (data.unprotected) { this.ready = true; return; }   // worker has no secret bound
    this.save(data.pass, data.ttl);
  },

  /* Called when the worker rejects a stale pass mid-session. */
  async refresh() {
    this.clear();
    await this.verify(await this.challenge());
  },
};

/* ── Boot overlay ──────────────────────────────────────────────
   A fake POST sequence that is doing something real: each line is a
   genuine step, and the bar only completes when verification does. */
const BootScreen = {
  el: null, barEl: null, lineEl: null,

  show() {
    this.el = document.getElementById('boot');
    if (!this.el) return;
    this.barEl = this.el.querySelector('.boot-bar i');
    this.lineEl = this.el.querySelector('.boot-line');
    document.body.classList.add('booting');
  },

  step(text, pct) {
    if (!this.el) return;
    if (this.lineEl) this.lineEl.textContent = text;
    if (this.barEl) this.barEl.style.width = pct + '%';
  },

  fail(text) {
    if (!this.el) return;
    this.el.classList.add('failed');
    if (this.lineEl) this.lineEl.textContent = text;
  },

  async hide() {
    if (!this.el) return;
    this.step('ready', 100);
    await new Promise(r => setTimeout(r, 260));
    this.el.classList.add('gone');
    document.body.classList.remove('booting');
    setTimeout(() => { if (this.el) this.el.hidden = true; }, 620);
  },
};

/* Runs before the terminal takes over. Never blocks the site: if
   verification fails the terminal still boots, and the assistant reports
   the problem when someone actually asks it something. */
async function runGate() {
  BootScreen.show();
  BootScreen.step('establishing session', 18);
  await new Promise(r => setTimeout(r, 240));

  if (Gate.restore()) {
    BootScreen.step('session restored', 82);
    await new Promise(r => setTimeout(r, 220));
    await BootScreen.hide();
    return;
  }

  BootScreen.step('verifying you are human', 42);

  /* Verification is raced against a short deadline. A real browser clears
     managed mode in about a second; anything slower is a blocked script, a
     corporate proxy, or a challenge the visitor has to click. None of those
     should hold the whole site behind a loading screen, so the boot screen
     lifts at the deadline and verification carries on in the background.

     Nothing is lost by that: only the assistant needs a pass, and if a
     question arrives first the worker's 401 triggers Gate.refresh().
     Before this, a blocked script meant 30 seconds of blank screen. */
  const verifying = (async () => {
    const token = await Gate.challenge();
    await Gate.verify(token);
  })();

  verifying.catch(err => { Gate.lastError = err.message; });

  const deadline = new Promise(r => setTimeout(() => r('slow'), BOOT_DEADLINE_MS));
  const outcome = await Promise.race([verifying.then(() => 'done', () => 'failed'), deadline]);

  if (outcome === 'done') BootScreen.step('session established', 94);
  else BootScreen.step('continuing in background', 94);
  await new Promise(r => setTimeout(r, 200));
  await BootScreen.hide();
}
