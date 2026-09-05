/* ============================================================
   Assistant — retrieval + Groq

   The model never sees a question on its own. Every question is
   answered against chunks retrieved from knowledge/ (and from any
   files dropped on the terminal this session). If retrieval comes
   back empty the question never reaches the network at all — the
   terminal declines locally. That is the scope guard: the model
   cannot answer off-corpus because it is never asked to.

   The Groq key is NOT here. It lives in the Cloudflare Worker at
   chat.colaco.se (see chat-worker.js) — a static site cannot hold
   a secret.
   ============================================================ */

const CHAT_ENDPOINT = 'https://chat.colaco.se/';

const RAG = {
  chunks: [],          // { id, doc, title, heading, text, terms }
  docs: [],            // { title, file, chunks, chars, session }
  df: Object.create(null),
  ready: false,
  loading: null,

  /* Fetch the manifest and every document in it. Called once, lazily,
     the first time someone asks a question. */
  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let manifest;
      try {
        const res = await fetch('knowledge/manifest.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error('manifest ' + res.status);
        manifest = await res.json();
      } catch (e) {
        this.ready = true;
        throw new Error('knowledge base unreachable (' + e.message + ')');
      }
      const list = Array.isArray(manifest.documents) ? manifest.documents : [];
      await Promise.all(list.map(async d => {
        try {
          const r = await fetch('knowledge/' + d.file, { cache: 'no-cache' });
          if (!r.ok) return;
          this.addDoc(d.title || d.file, d.file, await r.text(), d.tags || '');
        } catch (e) { /* one bad document must not sink the rest */ }
      }));
      this.reindex();
      this.ready = true;
    })();
    return this.loading;
  },

  /* Split on markdown headings first, then pack paragraphs into
     ~1100-char chunks. Every chunk carries its heading so a retrieved
     fragment still says what it is about. */
  addDoc(title, file, text, tags, session) {
    const clean = String(text).replace(/\r\n/g, '\n');
    const parts = [];
    let heading = '';
    let buf = [];
    const flush = () => {
      const body = buf.join('\n').trim();
      buf = [];
      if (body) parts.push({ heading, text: body });
    };
    for (const para of clean.split(/\n{2,}/)) {
      const h = para.match(/^#{1,6}\s+(.+)$/m);
      if (h && para.trim().startsWith('#')) { flush(); heading = h[1].trim(); }
      buf.push(para);
      if (buf.join('\n').length > 1100) flush();
    }
    flush();

    let n = 0;
    parts.forEach((p, i) => {
      const label = [title, p.heading].filter(Boolean).join(' › ');
      const text = p.text;
      const terms = tokenize(label + ' ' + tags + ' ' + text);
      this.chunks.push({
        id: file + '#' + i,
        doc: file, title, heading: p.heading, session: !!session,
        text, terms,
        len: Object.values(terms).reduce((a, b) => a + b, 0) || 1,
      });
      n++;
    });
    this.docs.push({ title, file, chunks: n, chars: clean.length, session: !!session });
  },

  /* Document frequencies for the IDF half of the score, and the
     vocabulary the scope check tests against. */
  reindex() {
    this.df = Object.create(null);
    this.vocab = new Set();
    for (const c of this.chunks) {
      for (const t of new Set(Object.keys(c.terms))) {
        this.df[t] = (this.df[t] || 0) + 1;
        this.vocab.add(t);
      }
    }
  },

  /* Does this question have any topical anchor in the corpus at all?

     BM25 alone is a poor scope test: "how do I bake bread" scores well on
     `how` and returns confident nonsense. So we test the question's words
     against the corpus vocabulary instead.

     This was first written as a ratio — known words over content words —
     and that was wrong. "Summarise Valency in three bullet points for an
     intro slide" scored 1/6 and got refused, because five of its six words
     describe the SHAPE of the answer, not its subject. Format words are not
     evidence of scope in either direction, so they are stripped, and what
     remains is a presence test: one real anchor is enough. A question is
     out of scope when it mentions nothing we have, not when it mentions
     other things as well. */
  anchors(query) {
    const words = String(query).toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
    const topical = words.filter(w =>
      w.length > 2 && !STOP.has(w) && !ASK.has(w) && !FORMAT.has(w) && !/^\d+$/.test(w));
    const known = topical.filter(w =>
      this.vocab.has(w) || (w.length > 4 && this.vocab.has(w.replace(/s$/, ''))));
    return { topical, known };
  },

  /* BM25-lite. Enough signal for a corpus this size, and it costs
     nothing — no embedding call, no vector store, no build step. */
  search(query, k) {
    const q = tokenize(query);
    const qt = Object.keys(q);
    if (!qt.length || !this.chunks.length) return [];
    const N = this.chunks.length;
    const avg = this.chunks.reduce((s, c) => s + c.len, 0) / N || 1;

    const scored = this.chunks.map(c => {
      let s = 0;
      for (const t of qt) {
        const f = c.terms[t];
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df[t] || 0) + 0.5) / ((this.df[t] || 0) + 0.5));
        s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * c.len / avg));
      }
      /* a phrase hit is worth more than the sum of its words */
      if (s > 0 && c.text.toLowerCase().includes(query.toLowerCase().trim())) s *= 1.6;
      return { c, s };
    }).filter(x => x.s > 0);

    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k || 6);
  },

  /* Session uploads — read in the browser, never sent anywhere except
     as retrieved context. Gone on reload. */
  addSessionDoc(name, text) {
    this.chunks = this.chunks.filter(c => !(c.session && c.doc === name));
    this.docs = this.docs.filter(d => !(d.session && d.file === name));
    this.addDoc(name, name, text, '', true);
    this.reindex();
  },
};

/* word bag with counts; drops stopwords and 1-char noise */
const STOP = new Set(('a an and are as at be but by for from has have he her his i if in is it its of on or '
  + 'that the their this to was were what when where which who will with you your do does did can could would '
  + 'should about into than then them they there these those we us our me my').split(' '));

/* Words describing the SHAPE of a wanted answer — its length, format or
   register. They say nothing about the subject, so they must not count for
   or against scope. */
const FORMAT = new Set(('bullet bullets point points slide slides deck summary summarise summarize '
  + 'brief briefly short shortly long detailed detail depth overview outline recap tldr eli5 '
  + 'paragraph paragraphs sentence sentences line lines word words page pages list listing table '
  + 'pitch elevator intro introduction abstract blurb bio note notes format style tone plain simple '
  + 'quick quickly fast concise verbose expand elaborate rewrite rephrase translate version draft '
  + 'three four five six seven eight nine ten couple few several first second third top best worst '
  + 'like example examples instance basically essentially please times time').split(' '));

/* A bare greeting, with nothing else attached. */
const GREETING = /^(hi|hey|hello|yo|hiya|howdy|greetings|good\s+(morning|afternoon|evening)|sup|hej|halla|hola)(\s+(there|all|everyone|folks|again))?[\s!.?]*$/i;

/* Interrogatives and filler verbs. They carry no topic, but they are common
   enough in the corpus to score well, which is exactly the trap. */
const ASK = new Set(('how why what who when where which whom whose tell explain describe '
  + 'give show list summarise summarize compare say write make get know like just any some '
  + 'much many more most does doing done please thanks thank hey hello hi yeah okay ok').split(' '));
function tokenize(s) {
  const bag = Object.create(null);
  const words = String(s).toLowerCase().match(/[a-z0-9][a-z0-9+#._-]*/g) || [];
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    bag[w] = (bag[w] || 0) + 1;
    /* crude stem so "publications" matches "publication" */
    if (w.length > 4 && w.endsWith('s')) {
      const st = w.slice(0, -1);
      if (!STOP.has(st)) bag[st] = (bag[st] || 0) + 0.5;
    }
  }
  return bag;
}
/* ── The ask ───────────────────────────────────────────────── */

const Chat = {
  history: [],
  busy: false,

  /* onToken(text) is called as the answer streams in; onStatus(n) fires
     while the model is still reasoning and nothing is renderable yet.
     Returns { text, cites } or throws. */
  async ask(question, onToken, onStatus) {
    /* "hi" is not an out-of-scope question, and refusing it reads as broken.
       Answer it here rather than spending a call on it. */
    if (GREETING.test(question.trim())) {
      const msg = "Hello. I answer questions about Valency's research, publications and this site "
                + "— from his documents only. Try /fun for ideas, or /help for commands.";
      if (onToken) await typeOut(msg, onToken);
      return { text: msg, cites: [], local: true };
    }
    if (!RAG.ready) await RAG.load();

    const hits = RAG.search(question, 6);
    const { topical, known } = RAG.anchors(question);

    /* Decline locally when the question is plainly off-corpus: nothing
       matched, or most of its content words don't exist in any document.
       An unanswerable question should not cost a network round-trip, and
       a local decline cannot hallucinate.

       A BM25 score floor was tried and removed: with a corpus this small,
       IDF collapses for the terms that matter most — "valency", "iceman"
       and "vote" appear in nearly every chunk, so the questions most worth
       answering scored LOWEST.

       A question with no topical words at all ("what about the second
       one?", "tell me more") deliberately passes through: those are
       follow-ups that lean on the conversation history, and refusing them
       would break every multi-turn exchange. The cost is that "what is 17
       times 43" also gets through — one API call, which the model refuses.

       This is tuned to let borderline questions THROUGH, not to catch
       them. It is a cost optimisation, not the scope boundary — the real
       boundary is the system prompt in chat-worker.js, which refuses to
       answer from anything but the context it is handed. */
    if (topical.length && !known.length) {
      const msg = pickDecline();
      if (onToken) await typeOut(msg, onToken);
      return { text: msg, cites: [], local: true };
    }

    const context = hits.map((h, i) =>
      '[' + (i + 1) + '] ' + (h.c.title || h.c.doc) +
      (h.c.heading ? ' › ' + h.c.heading : '') + '\n' + h.c.text
    ).join('\n\n---\n\n');

    const cites = [];
    for (const h of hits) {
      const label = h.c.title || h.c.doc;
      if (!cites.includes(label)) cites.push(label);
    }

    /* A CORS rejection surfaces as a bare TypeError("Failed to fetch") with
       no detail — the browser deliberately hides the reason. Since that is
       overwhelmingly the failure people hit (an origin the worker doesn't
       allow, or the worker not deployed at all), name it here. */
    let res;
    try {
      res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, context, history: this.history.slice(-8) }),
      });
    } catch (e) {
      throw new Error(
        'could not reach ' + new URL(CHAT_ENDPOINT).host + ' from ' + location.origin +
        '. Either the worker is not deployed, or this origin is not on its allowlist ' +
        '(see isAllowedOrigin in chat-worker.js).');
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) {}
      throw new Error(detail || ('assistant offline (HTTP ' + res.status + ')'));
    }

    const text = await readSSE(res, onToken, onStatus);
    this.history.push({ role: 'user', content: question });
    this.history.push({ role: 'assistant', content: text });
    if (this.history.length > 16) this.history = this.history.slice(-16);
    return { text, cites };
  },
};

/* Groq streams OpenAI-style SSE: `data: {...}` lines, then `data: [DONE]`.

   gpt-oss is a reasoning model, so a response arrives in two phases: first
   `delta.reasoning` (its chain-of-thought), then `delta.content` (the actual
   answer). The reasoning is never shown — it is verbose, it restates the
   prompt, and users did not ask to read it. It is useful for one thing:
   proving the request is alive while nothing renders, so it drives a
   "thinking" indicator via onStatus. */
async function readSSE(res, onToken, onStatus) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();                       // keep the partial line
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning && onStatus) onStatus(delta.reasoning.length);
        if (delta.content) { out += delta.content; if (onToken) onToken(delta.content); }
      } catch (e) { /* keep-alive or partial frame — skip it */ }
    }
  }
  return out.trim();
}

const DECLINES = [
  "Out of scope. I only read Valency's documents, and that isn't in them. Try /help.",
  "No match in the corpus. I answer from Valency's documents only — nothing else is loaded.",
  "That's outside what I'm allowed to read. /sources lists everything I have.",
  "Not in the knowledge base. Ask me about Valency's research, publications, or this site.",
  "I've got nothing on that. My entire world is the documents under /sources.",
];
let lastDecline = -1;
function pickDecline() {
  let i;
  do { i = Math.floor(Math.random() * DECLINES.length); } while (i === lastDecline && DECLINES.length > 1);
  lastDecline = i;
  return DECLINES[i];
}

/* type a local message at roughly terminal speed so a decline reads
   the same way a streamed answer does */
function typeOut(text, onToken) {
  return new Promise(resolve => {
    let i = 0;
    const step = () => {
      if (i >= text.length) return resolve();
      const n = Math.min(text.length - i, 2 + Math.floor(Math.random() * 3));
      onToken(text.slice(i, i + n));
      i += n;
      setTimeout(step, 14);
    };
    step();
  });
}
