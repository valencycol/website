#!/usr/bin/env python3
"""Export a pruned Model2Vec token table for the browser.

Model2Vec (MIT, github.com/MinishLab/model2vec) distils a sentence transformer
into STATIC embeddings: a token-to-vector table, so encoding a sentence is a
lookup plus a mean, not neural-network inference. That is what makes it
practical on a static site — the runtime is ~40 lines of JavaScript with no
ONNX, no WASM and no server.

potion-base-8M is 29,528 tokens x 256 dims, 28.8 MB as float32. This corpus
only ever uses 4,412 of those tokens, so the table is pruned to the tokens
that can actually appear (corpus + common English + every short subword piece,
so unseen words still decompose rather than vanish) and quantised to int8 with
a per-row scale. That lands around 1.7 MB, lazily loaded.

    pip install model2vec numpy
    python3 tools/build-embeddings.py
"""
import json, re, struct, sys
from pathlib import Path
import numpy as np
from model2vec import StaticModel

ROOT = Path(__file__).resolve().parent.parent
MODEL = "minishlab/potion-base-8M"
COMMON_IDS = 2000          # BERT vocab is roughly frequency-ordered. Larger values were
                           # measured (6k, 12k) and made no difference to any decision the
                           # site actually takes, so the smallest table wins.
SHORT_PIECE = 2            # keep every piece this short, so words decompose

def main():
    model = StaticModel.from_pretrained(MODEL)
    emb = model.embedding.astype(np.float32)
    vocab = model.tokenizer.get_vocab()
    inv = {i: t for t, i in vocab.items()}
    dims = emb.shape[1]

    corpus = []
    manifest = json.loads((ROOT / "knowledge/manifest.json").read_text())
    for doc in manifest["documents"]:
        corpus.append((ROOT / "knowledge" / doc["file"]).read_text())
    text = "\n".join(corpus)

    keep = set(range(COMMON_IDS))
    for i, tok in inv.items():
        if len(tok.replace("##", "")) <= SHORT_PIECE:
            keep.add(i)
    for start in range(0, len(text), 4000):
        keep.update(model.tokenizer.encode(text[start:start + 4000],
                                           add_special_tokens=False).ids)
    keep = sorted(keep)

    rows = emb[keep]
    scales = np.abs(rows).max(axis=1)
    scales[scales == 0] = 1.0
    q = np.clip(np.round(rows / scales[:, None] * 127.0), -127, 127).astype(np.int8)

    out = ROOT / "assets/data"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "embed.bin", "wb") as f:
        f.write(scales.astype(np.float32).tobytes())
        f.write(q.tobytes())
    (out / "embed.json").write_text(json.dumps({
        "model": MODEL, "dims": dims, "count": len(keep),
        "unk": "[UNK]", "prefix": "##", "maxWordChars": 100,
        "tokens": [inv[i] for i in keep],
    }, ensure_ascii=False))

    # Reference vectors so the JavaScript port can be proved equivalent.
    probes = ["what is iceman", "what can this site do?", "how fast is maverick",
              "why not", "the licentiate thesis", "sourdough bread",
              "Maverick is 85-563x faster than the state of the art",
              "", "   ", "Linköping University, Sweden", "SIGMA rule evasion detection",
              "who won the world cup", "best restaurants in stockholm",
              "quantum entanglement explained simply", "what is the price of bitcoin",
              "photosynthesis in tropical rainforest canopies"]
    (out.parent.parent / "tools/embed-reference.json").write_text(json.dumps({
        "probes": probes,
        "vectors": [model.encode(p).tolist() for p in probes],
    }))

    bin_mb = (out / "embed.bin").stat().st_size / 1024 / 1024
    json_mb = (out / "embed.json").stat().st_size / 1024 / 1024
    print(f"kept {len(keep)} of {emb.shape[0]} tokens x {dims} dims")
    print(f"embed.bin  {bin_mb:.2f} MB")
    print(f"embed.json {json_mb:.2f} MB  (gzips to roughly a third)")

if __name__ == "__main__":
    sys.exit(main())
