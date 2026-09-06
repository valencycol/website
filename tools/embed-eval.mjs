/* Task accuracy of the pruned browser table, against the decisions that
   matter: does a rephrased question find its prepared answer, and does an
   unrelated one stay out? Run: node tools/embed-eval.mjs */
import fs from 'fs';
import vm from 'vm';

const meta = JSON.parse(fs.readFileSync('assets/data/embed.json', 'utf8'));
const raw  = fs.readFileSync('assets/data/embed.bin');
const buf  = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const ctx = { console, document: { querySelector: () => null }, fetch: () => {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('assets/js/embed.js', 'utf8') + '\nthis.Embed = Embed;', ctx);
const E = ctx.Embed;
const n = meta.count, d = meta.dims;
E.dims = d; E.prefix = meta.prefix; E.maxWordChars = meta.maxWordChars;
E.scales = new Float32Array(buf, 0, n);
E.q = new Int8Array(buf, n * 4, n * d);
E.index = new Map(meta.tokens.map((t, i) => [t, i]));
E.ready = true;

const md = fs.readFileSync('knowledge/06-quick-answers.md', 'utf8');
const parts = md.split(/^### /m).slice(1);
const heads = parts.map(p => p.split('\n')[0].trim());
const bodies = parts.map(p => p.slice(p.split('\n')[0].length));
const HV = heads.map(h => E.encode(h));

const STOP = new Set(('a an and are as at be but by for from has have he her his i if in is it its of on or that the '
 + 'their this to was were what when where which who will with you your do does did can could would should about into '
 + 'than then them they there these those we us our me my how why some tell give show').split(' '));
const words = t => new Set((String(t).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !STOP.has(w)));
const hay = heads.map((h, i) => words(h + ' ' + bodies[i]));

function match(q, T) {
  const qv = E.encode(q);
  if (!qv) return null;
  let best = -1, bi = -1;
  HV.forEach((v, i) => { const s = E.cos(qv, v); if (s > best) { best = s; bi = i; } });
  if (best < T) return null;
  for (const w of words(q)) if (!hay[bi].has(w)) return null;   // asked a different thing
  return heads[bi];
}

const PAIRS = [
 ['what can this site do?', 'What can this website actually do?'],
 ['what can you do', 'What can this website actually do?'],
 ['what is this site for', 'What can this website actually do?'],
 ['iceman vs maverick', "What's the difference between Iceman and Maverick?"],
 ['how do iceman and maverick compare', "What's the difference between Iceman and Maverick?"],
 ['why should i read the thesis', 'Sell me on reading the thesis'],
 ['convince me to read it', 'Sell me on reading the thesis'],
 ['what should i read first', 'Which paper should I read first?'],
 ['where should i start reading', 'Which paper should I read first?'],
 ['how quick is maverick', 'How fast is Maverick, and why does the speed matter?'],
 ['why does maverick speed matter', 'How fast is Maverick, and why does the speed matter?'],
 ['what are sigma rule evasions', 'What is a SIGMA rule evasion?'],
 ['summarise the licentiate', 'Give me the elevator pitch for the licentiate thesis'],
 ['is this relevant to cars', 'Is any of this work relevant to automotive security?'],
 ['what should i ask him at a conference', 'What should I ask Valency about at a conference?'],
 ['explain evasion attacks quickly', 'Explain evasion attacks on tree ensembles like I have 60 seconds'],
 ['why is retraining a bad idea', 'Why is adversarial retraining a bad idea for tree ensembles?'],
];
const NEG = ['what is the capital of japan', 'will it snow in linkoping', 'what venue was iceman published in',
 'what is the price of bitcoin', 'who is simin nadjm-tehrani', 'how do i bake sourdough bread',
 'what is a random forest', 'best restaurants in stockholm', 'translate that to swedish',
 'what is the licentiate thesis published as', 'how many buoys did halyard deploy', 'when was maverick published',
 'what year was iceman published', "what is valency's email", 'how do i contact valency',
 'explain quantum entanglement simply', 'who won the world cup'];

console.log(`table: ${n} tokens x ${d} dims, ${(raw.length / 1024 / 1024).toFixed(2)} MB\n`);
for (const T of [0.45, 0.50, 0.55]) {
  const served = PAIRS.filter(([q, w]) => match(q, T) === w).length;
  const wrong  = PAIRS.filter(([q, w]) => { const m = match(q, T); return m && m !== w; }).length;
  const fp     = NEG.map(q => [q, match(q, T)]).filter(([, m]) => m);
  console.log(`T=${T.toFixed(2)}  served ${served}/${PAIRS.length}  misrouted ${wrong}  false matches ${fp.length}` +
    (fp.length ? '  ' + JSON.stringify(fp[0]) : ''));
}
const T = 0.50;
console.log('\nat T=0.50:');
for (const [q, w] of PAIRS) {
  const m = match(q, T);
  console.log(`  ${m === w ? 'served ' : m ? 'WRONG  ' : 'to-model'} ${q}`);
}
