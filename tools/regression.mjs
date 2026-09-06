/* Every failure this site has actually shipped, as a test.
 *
 * Each case below is a real bug a visitor hit, not a hypothetical. The point
 * is that fixing one must never quietly reintroduce another: run this before
 * every deploy.
 *
 *   python3 -m http.server 8080 &
 *   node tools/regression.mjs
 *
 * Exits non-zero if anything regresses. No network calls to Groq are made —
 * every check here is deterministic browser-side behaviour.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const BASE = process.env.BASE || 'http://localhost:8080/';
let failures = 0;
const pass = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const section = t => console.log(`\n${t}`);

/* ------------------------------------------------ Gemini stream translation
   The worker translates Gemini's SSE into the OpenAI-shaped frames the client
   already parses. An early version read one chunk per pull and returned having
   emitted nothing, which stalled forever on a real network — so the sizes
   below deliberately fragment the stream. */
section('gemini: streaming translation survives fragmentation');
{
  const src = fs.readFileSync('chat-worker.js', 'utf8');
  const fn = src.slice(src.indexOf('function geminiToOpenAI'), src.indexOf('/* Groq availability'));
  const geminiToOpenAI = new Function(fn + '\nreturn geminiToOpenAI;')();
  const frames = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Iceman is "}],"role":"model"}}]}', '',
    'data: {"candidates":[{"content":{"parts":[{"text":"a fast evasion detector."}],"role":"model"}}]}', '',
    ': keep-alive', '',
    'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[],"role":"model"}}]}', '',
  ].join('\n') + '\n';
  for (const size of [1, 5, 17, 1024]) {
    const bytes = new TextEncoder().encode(frames);
    const source = new ReadableStream({ start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    } });
    const rd = geminiToOpenAI(source).getReader();
    const dec = new TextDecoder();
    let text = '', hung = false;
    const timer = setTimeout(() => { hung = true; rd.cancel(); }, 5000);
    try { for (;;) { const { done, value } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); } }
    catch (e) { /* cancelled */ }
    clearTimeout(timer);
    let content = '', finished = false;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') { finished = true; continue; }
      try { content += JSON.parse(d).choices[0].delta.content || ''; } catch (e) {}
    }
    pass(`reassembles at ${size}-byte chunks`,
      !hung && finished && content === 'Iceman is a fast evasion detector.', hung ? 'HUNG' : content);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));

let modelCalls = 0;
let lastBody = null;
await page.addInitScript(() => {
  window.turnstile = { render: (_e, o) => { setTimeout(() => o.callback('T'), 40); return 'w'; }, reset: () => {} };
});
await page.route('**://chat.colaco.se/verify', r => r.fulfill({
  status: 200, headers: { 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify({ ok: true, pass: 'p', ttl: 1 }) }));
await page.route('**://chat.colaco.se/status', r => r.fulfill({
  status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
  body: '{"groq":"ok","seconds":0}' }));
await page.route('**://chat.colaco.se/', r => {
  modelCalls++; lastBody = JSON.parse(r.request().postData() || '{}');
  r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
    body: 'data: {"choices":[{"delta":{"content":"Linkoping is a city in Sweden with a university."}}]}\n\ndata: [DONE]\n\n' });
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof RAG !== 'undefined' && RAG.ready, null, { timeout: 30000 });
await page.evaluate(() => Embed.load());
await page.waitForFunction(() => Embed.ready, null, { timeout: 60000 });

const ask = async q => {
  const n0 = await page.locator('.msg.ai').count();
  const c0 = modelCalls;
  await page.fill('#cmdline', q);
  await page.press('#cmdline', 'Enter');
  await page.waitForFunction(n => {
    const m = document.querySelectorAll('.msg.ai');
    return m.length > n && !m[m.length - 1].classList.contains('thinking');
  }, n0, { timeout: 30000 });
  await page.waitForTimeout(500);
  const node = page.locator('.msg.ai').last();
  const text = (await node.innerText()).replace(/^assistant\s*/i, '').replace(/\s+/g, ' ').trim();
  return { text, used: modelCalls - c0 };
};
const cmd = async c => {
  await page.fill('#cmdline', c);
  await page.press('#cmdline', 'Enter');
  await page.waitForTimeout(400);
  return page.locator('#stream').innerText();
};

/* ---------------------------------------------------------------- grounding
   "latest developments in the eu ai act" once cited Valency's papers, and
   "how does a random forest work" is topically adjacent to them without
   being answered by them. */
section('grounding: is the corpus actually about this question?');
const ground = await page.evaluate(() => {
  const G = q => {
    const { topical, known } = RAG.anchors(q);
    const hits = RAG.search(q, 5);
    const cov = topical.length ? known.length / topical.length : 0;
    const dm = (() => {
      if (!hits.length || !known.length) return false;
      for (const h of hits.slice(0, 3)) {
        const t = new Set(String((h.c.title || '') + ' ' + (h.c.heading || '') + ' ' + (h.c.doc || ''))
          .toLowerCase().match(/[a-z0-9]+/g) || []);
        if (topical.some(w => w.length > 2 && t.has(w))) return true;
      }
      const c = hits[0].c;
      const blob = ((c.text || '') + ' ' + (c.title || '') + ' ' + (c.heading || '')).toLowerCase();
      return known.every(w => blob.includes(w));
    })();
    return hits.length > 0 && (RAG.namesDoc(topical) || (known.length >= 2 && cov >= 0.7 && dm));
  };
  const DOC = ['what is iceman', 'what is maverick', 'what are his publications',
    'can you print th maverick source', 'who is valency', 'what is evasion detection',
    'adversarial retraining tree ensembles', 'tell me about the siem rules paper',
    'show me the vote extension paper', 'how fast is maverick'];
  const WEB = ['why not', 'why', 'how so', 'linkoping', 'what are the latest developments in the eu ai act',
    'what is the weather here today', 'will it snow here', 'how do i bake sourdough bread',
    'who wrote the novel dune', 'what is the capital of japan', 'best restaurants in stockholm',
    'what is the price of bitcoin'];
  return { doc: DOC.filter(G), docN: DOC.length, web: WEB.filter(G), webN: WEB.length };
});
pass(`${ground.docN} document questions grounded`, ground.doc.length === ground.docN,
  ground.doc.length === ground.docN ? '' : 'missed: ' + ground.docN - ground.doc.length);
pass(`${ground.webN} general questions NOT grounded`, ground.web.length === 0,
  ground.web.join(', '));

/* ------------------------------------------------------------- follow-ups
   "Why not" was answered with adversarial retraining; "tell me more about the
   first point" with Harvard research on startup failure. */
section('follow-ups: does the question carry a subject of its own?');
const fu = await page.evaluate(() => {
  const FOLLOW = ['tell me more about the first point', 'tell me more', 'expand on the second one',
    'what about number 3', 'the last one', 'go deeper on that', 'why not', 'why', 'how so', 'say more',
    'elaborate on the third bullet', 'and the next one', 'what was the final point', 'more detail please'];
  const TOPIC = ['weather in linkoping', 'what is iceman', 'explain quantum entanglement',
    'why is adversarial retraining bad', 'linkoping', 'what can this site do', 'best restaurants in stockholm',
    'how fast is maverick', 'who wrote dune', 'what is the capital of japan',
    'tell me about the siem rules paper', 'sell me on reading the thesis'];
  return { missed: FOLLOW.filter(q => !isFollowUp(q, 4)), fN: FOLLOW.length,
           wrong: TOPIC.filter(q => isFollowUp(q, 4)), tN: TOPIC.length };
});
pass(`${fu.fN} discourse references recognised`, fu.missed.length === 0, fu.missed.join(', '));
pass(`${fu.tN} real topics left alone`, fu.wrong.length === 0, fu.wrong.join(', '));

/* ------------------------------------------------------------ state truth
   "is my context reset?" was answered "No" one line after the terminal
   printed that it had been. */
section('state: answered from memory, never guessed');
await cmd('/clear-memory');
let r = await ask('is my context reset?');
pass('empty conversation answers "yes"', /^yes/i.test(r.text) && r.used === 0, `calls=${r.used}`);
await ask('weather in linkoping');
r = await ask('is my context reset?');
pass('non-empty conversation answers "no"', /^no/i.test(r.text) && r.used === 0, `calls=${r.used}`);
pass('reports the real count', /carrying 1 exchange/.test(r.text), r.text.slice(0, 60));
r = await ask('what is a memory leak');
pass('genuine memory question still goes to the model', r.used === 1);

/* ------------------------------------------------- questions about the site
   "what can this site do?" was answered about an unrelated tools website. */
section('self-reference: this site is never web-searched');
await cmd('/clear-memory');
r = await ask('is this website open source and how was it built');
pass('site question suppresses the web search', lastBody.allowWeb === false, `allowWeb=${lastBody.allowWeb}`);
pass('site question carries document context', (lastBody.context || '').length > 0);
await ask('weather in linkoping');
await ask('what can we do here');
pass('"here" still means the city, not the site', lastBody.allowWeb === true);

/* ------------------------------------------------------- prepared answers
   "Sell me on reading the thesis" was answered with generic advice about
   theses in general, sourced from a study-skills blog. */
section('prepared answers: free, and matched by meaning');
await cmd('/clear-memory');
const FUN = await page.evaluate(() => FUN);
let free = 0;
for (const q of FUN) { const x = await ask(q); if (!x.used) free++; }
pass(`all ${FUN.length} suggested questions cost no tokens`, free === FUN.length, `${free}/${FUN.length}`);
r = await ask('how do iceman and maverick compare');
pass('an unanticipated rephrasing is matched semantically', r.used === 0);
r = await ask('what is the capital of japan');
pass('an unrelated question is NOT matched', r.used === 1);

/* --------------------------------------------------------------- commands */
section('commands');
let out = await cmd('/show maverick paper');
pass('/show matches on words', (await page.locator('.doc-dump').count()) > 0);
out = await cmd('/sudo');
pass('/sudo has no second line', !/has not been reported/.test(out));
out = await cmd('/memory');
pass('/memory reports held state', /CONVERSATION MEMORY/.test(out));
const before = await page.evaluate(() => RAG.chunks.filter(c => !c.session).length);
out = await cmd('/restart');
await page.waitForTimeout(1200);
const after = await page.evaluate(() => RAG.chunks.filter(c => !c.session).length);
pass('/restart keeps the knowledge base', before === after, `${before} -> ${after}`);
pass('/restart clears the conversation', (await page.evaluate(() => Chat.history.length)) === 0);

/* --------------------------------------------------------- model identity
   The site answered "I'm openai/gpt-oss-20b, served by Groq" while the Gemini
   light was lit and Gemini was in fact answering. Identity and the token
   allowance both come from whichever provider is serving. */
section('identity: the model card names the model that is answering');
for (const [primary, expectModel, expectLimit] of
     [['gemini', 'gemini-2.5-flash', 250000], ['groq', 'openai/gpt-oss-20b', 8000]]) {
  await page.evaluate(p => { ProviderLights.primary = p; ProviderLights.paint(); updateMem(); }, primary);
  const card = await ask('which model are you?');
  pass(`${primary}: model card says ${expectModel}`, card.text.includes(expectModel), card.text.slice(0, 60));
  const human = await ask('are you human?');
  pass(`${primary}: "are you human" is answered locally`, human.used === 0 && human.text.includes(expectModel));
  const title = await page.locator('#mem').getAttribute('title');
  pass(`${primary}: gauge is drawn against ${expectLimit}`, title.includes(String(expectLimit)), title.slice(0, 56));
}

/* ------------------------------------------------------- provider lights
   Which model answered changes the token budget by 30x, so a silent fallback
   from Gemini to Groq has to be visible. */
section('provider lights');
const lights = await page.evaluate(async () => {
  const read = () => ({
    gemHidden: document.querySelector('#prov-gemini').hidden,
    gem: document.querySelector('#prov-gemini').className,
    groq: document.querySelector('#prov-groq').className,
  });
  ProviderLights.primary = 'groq';
  ProviderLights.until = { gemini: 0, groq: 0 };
  ProviderLights.els.gemini.hidden = true;
  ProviderLights.paint();
  const noKey = read();
  ProviderLights.els.gemini.hidden = false;
  ProviderLights.active('gemini');
  const onGemini = read();
  ProviderLights.limited('gemini', 45);
  ProviderLights.active('groq');
  const fellBack = read();
  return { noKey, onGemini, fellBack };
});
pass('gemini hidden when not configured', lights.noKey.gemHidden && /\bon\b/.test(lights.noKey.groq));
pass('gemini lit when it answers', /\bon\b/.test(lights.onGemini.gem) && !/\bon\b/.test(lights.onGemini.groq));
pass('fallback shows gemini limited and groq lit',
  /limited/.test(lights.fellBack.gem) && /\bon\b/.test(lights.fellBack.groq));

/* ------------------------------------------------------------ vendoring
   /upload promises the file never leaves the browser. Fetching the converter
   from a CDN did not send the file anywhere, but it did tell that CDN an
   upload had happened. The converters are served from this origin now. */
section('uploads contact nobody');
{
  const outside = [];
  const watch = r => {
    const u = r.url();
    if (!/^data:|^blob:/.test(u) && !u.startsWith(BASE) && !/chat\.colaco\.se/.test(u)) {
      outside.push(new URL(u).host);
    }
  };
  page.on('request', watch);
  await page.setInputFiles('#file-input', ['tools/fixtures/sample.pdf']).catch(() => {});
  await page.waitForTimeout(4000);
  page.off('request', watch);
  const hosts = [...new Set(outside)];
  pass('no third party is told an upload happened', hosts.length === 0, hosts.join(', '));
  const converted = await page.evaluate(() => RAG.docs.filter(d => d.session).map(d => d.file));
  pass('the pdf was converted locally', converted.some(f => f.endsWith('.md')), converted.join(', '));
}

/* ------------------------------------------------------------ degradation */
section('degradation');
pass('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

console.log(`\n${failures ? failures + ' FAILURE(S)' : 'all checks passed'}`);
await browser.close();
process.exit(failures ? 1 : 0);
