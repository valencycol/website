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
        // Title + heading terms score much higher: a paper about Iceman
        // rarely repeats "Iceman" in its body, and the word is now common
        // across the corpus (the other papers cite it), so a body-only BM25
        // buries the paper for its own name. A title match restores it.
        titleTerms: tokenize(title + ' ' + (p.heading || '')),
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
      /* A query term appearing in the document title or section heading is
         a strong relevance signal that df-based IDF can't see. Weight it
         heavily so "what does iceman achieve" surfaces the Iceman paper, not
         another paper that merely cites it. */
      let titleHits = 0;
      for (const t of qt) if (c.titleTerms[t]) titleHits += 1;
      if (titleHits) s += titleHits * 3.5;

      /* a phrase hit is worth more than the sum of its words */
      if (s > 0 && c.text.toLowerCase().includes(query.toLowerCase().trim())) s *= 1.6;
      return { c, s };
    }).filter(x => x.s > 0);

    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, k || 6);
  },

  /* Does the question NAME one of the documents? "can you print the maverick
     source" scores 1-of-3 on coverage — "print" and "source" are not corpus
     vocabulary — so the coverage gate sent it to the web, which answered
     about Ford pickup trucks. A question that names a document is about that
     document whatever else it contains.

     Titles and filenames only, never headings: a heading match is far too
     loose ("work" appears in one, which would ground "how does TLS work").
     Ubiquitous words are skipped — a term in most chunks identifies nothing. */
  namesDoc(topical) {
    const ceiling = this.chunks.length * 0.6;
    for (const w of topical) {
      if (w.length < 4 || (this.df[w] || 0) > ceiling) continue;
      for (const d of this.docs) {
        if ((d.title + ' ' + d.file).toLowerCase().includes(w)) return true;
      }
    }
    return false;
  },

  /* The indexed text of one document, in order — what /show prints. */
  docText(file) {
    return this.chunks.filter(c => c.doc === file).map(c => c.text).join('\n\n');
  },

  /* Session uploads — read in the browser, never sent anywhere except
     as retrieved context. Gone on reload. */
  addSessionDoc(name, text) {
    this.dropSessionDoc(name);
    this.addDoc(name, name, text, '', true);
    this.reindex();
  },

  /* Drop one session document, or every one when name is omitted. Only ever
     touches session uploads — the files under knowledge/ are not removable
     from the browser, and a visitor should not be able to blank the corpus.
     Returns the names actually removed. */
  dropSessionDoc(name) {
    const gone = this.docs
      .filter(d => d.session && (!name || d.file === name))
      .map(d => d.file);
    if (!gone.length) return gone;
    const drop = new Set(gone);
    this.chunks = this.chunks.filter(c => !(c.session && drop.has(c.doc)));
    this.docs   = this.docs.filter(d => !(d.session && drop.has(d.file)));
    this.reindex();
    return gone;
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
  + 'like example examples instance basically essentially please times time '
  + 'latest recent current today todays now currently lately nowadays recently ongoing live '
  + 'update updates happening headlines news' ).split(' '));

/* A bare greeting, with nothing else attached. */
const GREETING = /^(hi|hey|hello|yo|hiya|howdy|greetings|good\s+(morning|afternoon|evening)|sup|hej|halla|hola)(\s+(there|all|everyone|folks|again))?[\s!.?]*$/i;

/* A follow-up that refers back to the conversation rather than naming a new
   subject — "translate the above", "summarise that", "in English", "explain
   it". These must NOT be web-searched: the query is meaningless to a search
   engine, and searching it throws away the conversation history the answer
   actually needs. They pass through with history so the model handles them. */
const REFERS_BACK = /\b(the above|above|previous|earlier|preceding|the (text|answer|list|passage|response|reply|message|paragraph)|last (one|answer|reply|message))\b/i;
const META_ON_REF = /\b(translate|summari[sz]e|rewrite|rephrase|shorten|expand|elaborate|explain|rephrase)\b[\s\S]*\b(it|that|this|these|those|above)\b/i;
const BARE_META   = /^(translate|summari[sz]e|rewrite|rephrase|shorten|expand|elaborate)( (it|that|this|the above|the text|the list))?[.?!\s]*$/i;
const IN_LANGUAGE = /^(in|to|into)\s+(english|swedish|french|spanish|german|hindi|arabic|chinese|mandarin|japanese|italian|portuguese|russian|dutch)\b/i;
const BACKREF = /\b(this|that|it|these|those|them|everything|the above|all (this|that|of it|of this|of that)|the whole (thing|text|list|passage))\b/i;
const A_LANGUAGE = /\b(swedish|english|french|spanish|german|hindi|arabic|chinese|mandarin|japanese|italian|portuguese|russian|dutch|korean|norwegian|danish|finnish)\b/i;
/* The place the conversation is about — learned from "weather in linkoping",
   "events in X", etc. — so a later location-implicit web query ("events this
   weekend", "restaurants nearby") can be searched in the right city. */
const PLACE_CUE = /\b(?:in|at|near|around|from)\s+([a-zà-öø-ÿ][\wà-öø-ÿ'’.-]+(?:\s+[a-zà-öø-ÿ][\wà-öø-ÿ'’.-]+)?)/i;
const LOC_IMPLICIT = /\b(here|nearby|near me|around here|this (weekend|week|evening|month|afternoon|morning|area)|tonight|today|tomorrow|events|gigs|concerts|what'?s on|whats on|restaurants?|cafes?|things to do|attractions|museums?|weather|forecast)\b/i;

/* A question that only operates on text already on screen — "translate the
   above", "summarise that", "in swedish" — has nothing to look up. Every
   other question gets a live search, so answers stay current and citable. */
/* Coverage alone says a question's words are IN the corpus, not that the
   corpus is ABOUT it. "latest developments in the eu ai act" scores coverage
   1.0 — "developments" and "act" both occur — and would otherwise be answered
   with Valency's papers cited underneath. Rarity can't separate them either:
   those two terms are RARER in this corpus (0% and 1% of chunks) than
   "iceman" (28%).
   What does separate them is whether the match reaches a document's identity:
   a topical word in a title or heading, or all matched words together in one
   chunk. Measured over 24 questions this splits 11/12 document questions from
   12/12 general ones. */
function docMatch(hits, topical, known) {
  if (!hits.length || !known.length) return false;
  for (const h of hits.slice(0, 3)) {
    const t = ((h.c.title || '') + ' ' + (h.c.heading || '') + ' ' + (h.c.doc || '')).toLowerCase();
    if (topical.some(w => w.length > 2 && t.includes(w))) return true;
  }
  const c = hits[0].c;
  const blob = ((c.text || '') + ' ' + (c.title || '') + ' ' + (c.heading || '')).toLowerCase();
  return known.every(w => blob.includes(w));
}

/* Prepared answers for the questions /fun suggests. Serving them straight
   from knowledge/06-quick-answers.md costs no model tokens, cannot drift into
   generalities ("this thesis will stretch your thinking"), and cannot be rate
   limited. Anything phrased differently still goes to the model, which has the
   same file in its corpus. */
const QUICK_DOC = '06-quick-answers.md';
let QUICK_CACHE = null;

function normQ(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function quickAnswers() {
  if (QUICK_CACHE) return QUICK_CACHE;
  QUICK_CACHE = new Map();
  const text = RAG.docText ? RAG.docText(QUICK_DOC) : '';
  for (const part of String(text).split(/^###\s+/m).slice(1)) {
    const nl = part.indexOf('\n');
    if (nl < 0) continue;
    const q = part.slice(0, nl).trim();
    const a = part.slice(nl + 1).trim();
    if (q && a) QUICK_CACHE.set(normQ(q), a);
  }
  return QUICK_CACHE;
}

function isMetaOnly(q) {
  return BARE_META.test(q) || IN_LANGUAGE.test(q) || META_ON_REF.test(q) || REFERS_BACK.test(q);
}

function isFollowUp(q, historyLen) {
  if (historyLen < 2) return false;   // needs a prior exchange to refer to
  if (REFERS_BACK.test(q) || META_ON_REF.test(q) || BARE_META.test(q) || IN_LANGUAGE.test(q)) return true;
  /* Typo-proof fallback: a SHORT message that hinges on a back-reference
     ("ranslate all this o swedish" — verb mangled, but "all this" is clearly
     the previous answer). A message this short that points at "this"/"that"
     is referring to the conversation, not naming a new subject to search. */
  /* Locational back-references to the place the conversation established —
     "here", "this city", "the local church" — regardless of length. "local"
     is excluded when another place or a year is named (a new topic). */
  const LOCATIONAL = /\b(here|there|nearby|around here|this (city|town|place|area|region)|the (city|town|place|area))\b/i;
  const LOCAL_REF = /\blocal\b/i.test(q) && !/\b(sweden|swedish|england|uk|usa|india|london|\d{4})\b/i.test(q);
  if (LOCATIONAL.test(q) || LOCAL_REF) return true;

  const words = q.trim().split(/\s+/).length;
  if (words <= 7 && BACKREF.test(q)) return true;
  return false;
}

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
/* ============================================================
   Task-type router

   Nothing is refused. Two kinds of input have fixed, correct answers, so
   they are handled here rather than spending a call on them; everything
   else goes to retrieval and then the model.

     greeting   "hi"                      → answered here
     meta       "what model are you?"     → answered here, from MODEL_CARD
     normal     everything else           → retrieval, then the model

   Retrieval no longer gates anything. It supplies context when the corpus
   has some, and says so when it doesn't — the model answers either way,
   from its own knowledge if need be, and is told to be explicit about
   which it used.
   ============================================================ */

/* Facts about the assistant itself. Legitimate questions with fixed
   answers — no reason to spend a model call, and no reason to refuse. */
const MODEL_CARD = [
  [/\b(which|what)\s+(ai\s+)?(model|llm|engine)\b|\bwhat\s+are\s+you\s+(running|built)\s+on\b|\bwhich\s+ai\b/i,
   "I'm openai/gpt-oss-20b, served by Groq, behind a Cloudflare Worker that holds the API key — "
   + "this site is static, so the key can't live in the page. My answers are grounded in the documents under /sources."],

  [/\b(who|what)\s+(made|built|created|wrote|designed)\s+(you|this)\b|\bwhose\s+(site|website)\b/i,
   "This is Valency Oscar Colaco's site. I'm the terminal assistant built into it — I answer from his documents and nothing else. /about has the long version."],

  [/\bare\s+you\s+(chatgpt|gpt|claude|gemini|an?\s+(real\s+)?(human|person|bot|ai|llm|robot|chatbot))\b|\bare\s+you\s+sentient\b/i,
   "A language model, not a person — gpt-oss-20b on Groq. I only know what's in Valency's documents, which makes me a narrow one."],

  [/\bwhat\s+can\s+you\s+(do|help|answer)\b|\bwhat\s+do\s+you\s+know\b|\bhow\s+do\s+you\s+work\b|\bwhat\s+are\s+you\s+for\b/i,
   "I answer questions about Valency's research, publications and this website — grounded in the files listed by /sources. "
   + "Type /fun for questions worth asking, or /help for the full command list. Anything outside those documents, I decline."],

  [/\b(do|will)\s+you\s+(store|save|keep|remember|log|train)\b|\b(my|the)\s+(data|privacy|uploads?)\b|\bis\s+this\s+private\b/i,
   "Files you add with /upload (.txt, .pdf or .docx) are converted to Markdown inside your browser and indexed for this session only \u2014 the file itself never leaves your machine, and excerpts go to the model only as retrieved context when they answer your question. "
   + "Questions are sent to Groq via the site's worker to be answered, and the question text is kept for 14 days "
   + "so Valency can see what people ask — no IP address, no identifier, nothing linking questions to each other. "
   + "When the answer needs the live web (anything not in Valency's documents), the question is also sent to the "
   + "LangSearch web-search API to fetch sources. Greetings and questions about me are answered in your browser "
   + "and never sent anywhere."],
];

function classify(query) {
  const q = String(query).trim();
  if (GREETING.test(q)) return { kind: 'greeting' };

  for (const [re, answer] of MODEL_CARD) {
    if (re.test(q)) return { kind: 'meta', answer };
  }

  return { kind: 'normal' };
}


/* ── The ask ───────────────────────────────────────────────── */

/* Token gauge. Groq's free tier caps gpt-oss-20b at 8000 tokens/minute, and
   every request spends: the system prompt + the conversation history + this
   turn's context + question + reserved output. The bar shows the part the
   CONVERSATION fixes (system + history + reserved output) against that 8000,
   and the chat resets when it climbs high enough that a normal question on top
   would risk the ceiling. ~4 chars/token; SYS_TOKENS/OUT_TOKENS approximate
   the worker's system prompt and MAX_TOKENS_OUT. */
const TPM_LIMIT   = 8000;
const SYS_TOKENS  = 560;
const OUT_TOKENS  = 1100;
const RESET_TOKENS = 5200;   // reset the conversation once its load passes this

const Chat = {
  history: [],
  place: '',
  topic: '',
  topicGrounded: false,
  busy: false,

  /* onToken(text) is called as the answer streams in; onStatus(n) fires
     while the model is still reasoning and nothing is renderable yet.
     onStatus(n, info) also fires with { waiting: seconds } while a rate
     limit is being waited out. Returns { text, cites, grounded } or throws. */
  /* Estimated tokens this conversation forces into every request: the system
     prompt, the compacted history, and the reserved output. */
  memTokens() {
    const histChars = this.compactHistory().reduce((n, m) => n + (m.content || '').length, 0);
    return SYS_TOKENS + OUT_TOKENS + Math.ceil(histChars / 4);
  },

  /* Compact the history before sending so a long chat can't blow the model's
     per-minute token budget. Recent exchanges go verbatim (follow-ups lean on
     them); older ones are truncated to an excerpt — enough to keep the gist,
     a fraction of the size. The worker enforces a hard cap on top of this. */
  compactHistory() {
    /* Full recent history — no per-message truncation. The token-based reset
       (RESET_TOKENS) clears it before it grows dangerous, and the worker's
       fitBudget is the hard backstop, so the load can climb honestly and the
       gauge reflects real accumulation. */
    return this.history.slice();
  },

  /* Forget the conversation — clears the memory a follow-up would draw on. */
  reset() { const n = this.history.length; this.history = []; this.place = ''; this.topic = ''; this.topicGrounded = false; return n; },

  async ask(question, onToken, onStatus, retried) {
    const route = classify(question);

    /* Greetings and questions about the assistant itself are legitimate and
       have fixed answers. Refusing them, as this used to, reads as broken. */
    if (route.kind === 'greeting') {
      const msg = "Hello. I answer questions about Valency's research, publications and this site "
                + "— from his documents only. Try /fun for ideas, or /help for commands.";
      if (onToken) await typeOut(msg, onToken);
      return { text: msg, cites: [], local: true };
    }
    if (route.kind === 'meta') {
      if (onToken) await typeOut(route.answer, onToken);
      return { text: route.answer, cites: [], local: true };
    }
    if (!RAG.ready) await RAG.load();

    /* One of the suggested questions, with an answer already written. No
       model call, no web search, no rate limit — and it still goes into the
       history, so a follow-up can build on it. */
    const canned = quickAnswers().get(normQ(question));
    if (canned) {
      if (onToken) await typeOut(canned, onToken);
      this.history.push({ role: 'user', content: question });
      this.history.push({ role: 'assistant', content: canned });
      return { text: canned, cites: ['Quick answers'], grounded: true, sources: [] };
    }

    const followUp = isFollowUp(question, this.history.length);

    /* The conversation's token load has climbed near the per-minute ceiling —
       reset before answering so the next request stays under 8000. Follow-ups
       are spared so "translate that" at the boundary still has its context. */
    if (!retried && !followUp && this.memTokens() > RESET_TOKENS) {
      this.history = [];
      this.place = '';
      this.topic = '';
      this.topicGrounded = false;
      if (onStatus) onStatus(0, { reset: true, proactive: true });
    }

    /* Learn / carry the place. If this question names a place, remember it;
       if it is location-implicit and names none, reuse the remembered one so
       the web search runs in the right city instead of a random one. */
    const named = question.match(PLACE_CUE);
    if (named) this.place = named[1].trim().replace(/[.?!,]+$/, '');
    const searchPlace = (!named && LOC_IMPLICIT.test(question) && this.place) ? this.place : '';
    /* The web search runs for everything except a pure text operation. A
       follow-up searches for the topic the conversation established, not its
       own bare words — "tell me more" on its own finds nothing useful. */
    const metaOnly = isMetaOnly(question);
    if (!followUp) this.topic = question.slice(0, 120);
    let searchQuery = (followUp && this.topic && !metaOnly)
      ? question + ' ' + this.topic
      : question;

    /* A follow-up retrieves on the topic it is continuing, not on its own
       bare words: "how is it different from maverick" alone retrieves nothing
       and web-searches into Top Gun. Anchored to "what is iceman" it finds
       both papers. */
    const retrievalQ = (followUp && this.topic) ? question + ' ' + this.topic : question;

    /* The visitor's own uploads outrank everything. They are retrieved from
       the same index but kept in their own list, so they can be sent as a
       separate, higher-priority block rather than competing with the site's
       corpus for the same five slots. */
    const allHits = RAG.search(retrievalQ, 12);
    const upHits  = allHits.filter(h => h.c.session).slice(0, 5);
    const hits    = allHits.filter(h => !h.c.session).slice(0, 5);
    const { topical, known } = RAG.anchors(retrievalQ);

    /* The corpus is consulted first and always. When it has something
       relevant, it is supplied as context and the model is told to prefer
       it. When it has nothing, the model answers from its own knowledge
       instead — and is told to say so.

       `grounded` reports which happened, so the terminal can label the
       answer honestly: cited sources when it came from Valency's
       documents, a plain marker when it did not. Retrieval no longer
       gates anything; it only informs. */
    /* No score threshold here, for the same reason there is no score floor
       on the gate: with a corpus this small, IDF collapses for the terms
       that matter most. "What is Iceman" tops out at 0.42 — a 0.4 cutoff
       called it ungrounded on a rounding error. Whether the question has a
       real anchor in the vocabulary is the reliable signal; search already
       drops anything scoring zero. */
    /* Grounding needs more than one incidental word in common with the
       corpus. "Latest news from mumbai" shares the word "news" with the
       site's /news feature and would otherwise be treated as a Valency
       question — sending doc context, suppressing the web search, and
       leaving the model to shrug. Requiring the known words to be at least
       HALF of the question's content words fixes it: "news from mumbai" is
       1-of-3 (→ web), "who won the world cup" is 2-of-3 (→ web), while
       "what is Iceman" is 1-of-1 and "adversarial retraining bad for tree
       ensembles" is 4-of-5 (→ docs).
       Coverage, not score: score is useless here because a rare incidental
       word ("news", df 1) scores HIGH while the terms that matter ("iceman",
       in most chunks) score low. */
    const coverage = topical.length ? known.length / topical.length : 0;
    /* A follow-up is about the conversation — it uses history, not a fresh
       doc lookup or a web search. Forcing it ungrounded stops "what can we
       do here?" grounding to the site's own docs ("here" = the city we've
       been discussing, not this website). */
    /* Grounded when the corpus is genuinely about the question. A follow-up
       inherits the topic's verdict: if the conversation was about Valency's
       papers, its follow-ups still get the papers — otherwise the model is
       left to answer "which venue was it published in" from web results, and
       a search for those words lands on Marvel and Top Gun. */
    const groundedNow = hits.length > 0 && (
      RAG.namesDoc(topical) ||
      (known.length > 0 && coverage >= 0.7 && docMatch(hits, topical, known))
    );
    if (!followUp) this.topicGrounded = groundedNow;
    const grounded = followUp ? (this.topicGrounded && hits.length > 0) : groundedNow;

    /* A document question whose subject shares a name with something famous
       — "what is iceman" — searches straight into Marvel and Top Gun, and the
       model then volunteers a disambiguation nobody asked for. Scoping the
       query to the document's own title and author turns the same search into
       one that finds the actual paper. */
    if (grounded && hits.length) {
      searchQuery = question + ' ' + (hits[0].c.title || '') + ' Valency Colaco';
    }

    /* Context goes up only when the corpus actually has a claim on the
       question. Sending Valency's bio alongside "write a prime sieve" is
       noise the model has to ignore, and it makes the answer's provenance
       ambiguous — the label the visitor sees should match what was sent. */
    const context = grounded
      ? hits.map((h, i) =>
          '[' + (i + 1) + '] ' + (h.c.title || h.c.doc) +
          (h.c.heading ? ' \u203a ' + h.c.heading : '') + '\n' + h.c.text
        ).join('\n\n---\n\n')
      : '';

    /* Cite every document that went up as context — no relevance cut.

       A cut was tried at several thresholds and none of them held: for "how
       fast is Maverick" the agent-guide chunk scores 0.50 of the top hit,
       tied with a genuine one, because that document is short and "fast" is
       prominent in it. BM25 is not misbehaving; the docs are just uneven.

       More to the point, this list is a provenance statement, not a
       relevance ranking. Every one of these chunks was visible to the model,
       so hiding one would imply the answer could not have come from it. */
    /* Uploaded documents go up whenever they matched at all — the visitor
       put them there for this conversation, so they do not have to clear the
       grounding bar the site's own corpus does. */
    const uploads = upHits.length
      ? upHits.map((h, i) =>
          '[' + (i + 1) + '] ' + (h.c.title || h.c.doc) +
          (h.c.heading ? ' \u203a ' + h.c.heading : '') + '\n' + h.c.text
        ).join('\n\n---\n\n')
      : '';

    const cites = [];
    for (const h of upHits) {
      const label = (h.c.title || h.c.doc) + ' (yours)';
      if (!cites.includes(label)) cites.push(label);
    }
    if (grounded) {
      for (const h of hits) {
        const label = h.c.title || h.c.doc;
        if (!cites.includes(label)) cites.push(label);
      }
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
        body: JSON.stringify({ question, context, uploads, allowWeb: !metaOnly, searchQuery, place: searchPlace, history: this.compactHistory(),
                               pass: (typeof Gate !== 'undefined' ? Gate.pass : '') }),
      });
    } catch (e) {
      throw new Error(
        'could not reach ' + new URL(CHAT_ENDPOINT).host + ' from ' + location.origin +
        '. Either the worker is not deployed, or this origin is not on its allowlist ' +
        '(see isAllowedOrigin in chat-worker.js).');
    }

    /* Rate limits are a normal operating condition here, not a failure:
       Groq's free tier is generous but finite, and the worker adds a per-IP
       budget of its own. Wait the interval the server names and try once
       more — most limits are a short burst window, so one patient retry
       clears them. Two failures in a row is a real queue, and then we say
       so plainly rather than retrying forever. */
    /* The pass expired, or the visitor never got one. Solve a fresh
       challenge and retry once — silently, since this is housekeeping
       rather than something they did wrong. */
    if (res.status === 401 && typeof Gate !== 'undefined' && !retried) {
      try {
        if (onStatus) onStatus(0, { verifying: true });
        await Gate.refresh();
        return this.ask(question, onToken, onStatus, true);
      } catch (e) {
        throw new Error('could not verify this browser with Turnstile: ' + e.message
          + '. Reload the page to try again.');
      }
    }

    /* The conversation got too big for the model's token budget. Reset it and
       retry once from a clean slate. onStatus signals the terminal to print a
       reset notice and update the memory meter. */
    if (res.status === 413 && !retried) {
      this.history = [];
      this.place = '';
      this.topic = '';
      this.topicGrounded = false;
      if (onStatus) onStatus(0, { reset: true });
      return this.ask(question, onToken, onStatus, true);
    }

    if (res.status === 429) {
      let wait = 0, msg = '';
      try {
        const j = await res.json();
        wait = Number(j.retryAfter) || 0;
        msg = j.error || '';
      } catch (e) { /* no body — fall back to the header */ }
      if (!wait) wait = Number(res.headers.get('Retry-After')) || 8;
      wait = Math.min(Math.max(wait, 2), 60);

      if (!retried) {
        /* Light the GROQ indicator red immediately, rather than waiting for
           the next background poll to notice. */
        if (typeof GroqLight !== 'undefined') GroqLight.limited(wait);
        if (onStatus) onStatus(0, { waiting: wait });
        await new Promise(r => setTimeout(r, wait * 1000));
        return this.ask(question, onToken, onStatus, true);   // one retry, then stop
      }
      const e = new Error(msg || ('busy — the assistant is rate limited. Try again in about '
                + wait + ' second' + (wait === 1 ? '' : 's') + '.'));
      e.rateLimited = true;
      e.retryAfter = wait;
      throw e;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error || ''; } catch (e) {}
      throw new Error(detail || ('assistant offline (HTTP ' + res.status + ')'));
    }

    const { text, sources } = await readSSE(res, onToken, onStatus);
    this.history.push({ role: 'user', content: question });
    this.history.push({ role: 'assistant', content: text });
    if (this.history.length > 60) this.history = this.history.slice(-60);
    return { text, cites, grounded, sources, followUp };
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
  const sources = [];   // web citations, when the worker searched the web
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
        const obj = JSON.parse(payload);
        // Custom frame the worker prepends when it answered from a web
        // search — not a Groq frame. Capture the links and move on.
        if (obj.type === 'sources' && Array.isArray(obj.sources)) {
          for (const src of obj.sources) {
            if (src && typeof src.url === 'string' && /^https:\/\//i.test(src.url)) {
              sources.push({ title: String(src.title || src.url), url: src.url });
            }
          }
          continue;
        }
        const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
        if (!delta) continue;
        if (delta.reasoning && onStatus) onStatus(delta.reasoning.length);
        if (delta.content) { out += delta.content; if (onToken) onToken(delta.content); }
      } catch (e) { /* keep-alive or partial frame — skip it */ }
    }
  }
  return { text: out.trim(), sources };
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
    /* Roughly 150 steps whatever the length, so a long prepared answer lands
       in about two seconds instead of trickling out for ten. */
    const base = Math.max(2, Math.ceil(text.length / 150));
    const step = () => {
      if (i >= text.length) return resolve();
      const n = Math.min(text.length - i, base + Math.floor(Math.random() * 3));
      onToken(text.slice(i, i + n));
      i += n;
      setTimeout(step, 14);
    };
    step();
  });
}
