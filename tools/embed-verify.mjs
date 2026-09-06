/* Prove the browser port of model2vec matches the Python reference.
   Run: node tools/embed-verify.mjs   (after tools/build-embeddings.py) */
import fs from 'fs';
import vm from 'vm';

const meta = JSON.parse(fs.readFileSync('assets/data/embed.json', 'utf8'));
const raw  = fs.readFileSync('assets/data/embed.bin');
const buf  = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const ref  = JSON.parse(fs.readFileSync('tools/embed-reference.json', 'utf8'));

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

let worst = 1, fails = 0;
for (let i = 0; i < ref.probes.length; i++) {
  const probe = ref.probes[i];
  const want = ref.vectors[i];
  const got = E.encode(probe);
  if (!got) {
    // Python returns a zero vector where we return null; both mean "no signal".
    const mag = Math.hypot(...want);
    const ok = mag < 1e-6;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  (empty)          ${JSON.stringify(probe).slice(0, 46)}`);
    if (!ok) fails++;
    continue;
  }
  let dot = 0;
  for (let k = 0; k < d; k++) dot += got[k] * want[k];
  worst = Math.min(worst, dot);
  const ok = dot > 0.995;
  if (!ok) fails++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  cos=${dot.toFixed(6)}  ${JSON.stringify(probe).slice(0, 46)}`);
}
console.log(`\nworst cosine vs Python reference: ${worst.toFixed(6)}  ${fails ? fails + ' FAILURES' : '(int8 quantisation accounts for the gap)'}`);
process.exit(fails ? 1 : 0);
