# colaco.se

A personal site shaped like a terminal. Visitors type slash-commands, or ask an
AI assistant a question in plain English. The assistant answers from the
documents in [`knowledge/`](knowledge/), runs a live web search alongside them,
and cites which it used.

It is a **static site on GitHub Pages** plus **two Cloudflare Workers** that
hold the things a static page cannot: API keys, and an allowlisted feed proxy.

```
Browser ──► GitHub Pages (this repo, static)
   │
   ├─► chat.<domain>  (Worker: colaco-chat) ──► Gemini → Groq · Turnstile · LangSearch · KV · Email
   └─► feeds.<domain> (Worker: feeds)       ──► RSS / Ground News / CISA (allowlisted)
```

Nothing is fetched from a CDN. One local photo, an inline SVG favicon, no web
fonts, and the document converters vendored under `assets/vendor/`. Only
Turnstile is remote, because a bot check served from the site it protects would
be pointless.

---

## What you need to provide, and where it goes

Three kinds of value. Only the first two are secret.

### 1 · Cloudflare Worker secrets — on the `colaco-chat` worker

Pushed with `wrangler secret put <NAME> --name colaco-chat` (never committed).

| Secret | Needed for | Get it from | If unset |
|---|---|---|---|
| `GROQ_API_KEY` | the assistant's fallback provider | <https://console.groq.com/keys> | assistant returns HTTP 500 (unless Gemini is set) |
| `GEMINI_API_KEY` | the assistant's **primary** provider | <https://aistudio.google.com/apikey> | Groq answers everything, at a much smaller budget |
| `TURNSTILE_SECRET` | the bot gate | your Turnstile widget (step 3) | **gate is disabled** — the endpoint is open |
| `LANGSEARCH_API_KEY` | live web search | <https://langsearch.com/dashboard> (free) | answers rely on the documents and the model's own memory, with no web sources |

### 2 · GitHub Actions secrets — repo → Settings → Secrets and variables → Actions

Only needed to **auto-deploy the workers from CI** on push
(`.github/workflows/workers.yml`). Pages itself needs none of these.

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | a token with **Workers Scripts: Edit**, **Workers KV Storage: Edit**, **Account Settings: Read** |
| `CLOUDFLARE_ACCOUNT_ID` | your Cloudflare account id |

### 3 · Public config — committed in the code, NOT secret

| Value | Where | Note |
|---|---|---|
| Turnstile **sitekey** | `assets/js/turnstile.js` (`TURNSTILE_SITEKEY`) | public by design — pairs with the secret above |
| KV namespace **id** | `wrangler.jsonc` (`kv_namespaces[].id`) | identifier, not a secret |
| `GEMINI_MODEL` | `wrangler.jsonc` (`vars`) | model id — see below |
| `GROQ_MODEL` | optional var, defaults in code | `openai/gpt-oss-20b` |
| Worker URLs | `assets/js/chat.js`, `turnstile.js`, `feeds.js` | your `chat.` / `feeds.` subdomains |

> `.env` is **gitignored and read by nothing at runtime.** It is just your local
> scratchpad to paste keys into before running `wrangler secret put`.

---

## Model providers

The worker tries **Gemini** first and falls back to **Groq**. Either alone
works; both together is what you want.

| | free tier | questions/min at the current prompt size |
|---|---|---|
| Gemini (`gemini-3.1-flash-lite`) | 250,000 tokens/min | ~83 |
| Groq (`openai/gpt-oss-20b`) | 8,000 tokens/min | ~2.7 |

Groq is kept wired rather than replaced, because Gemini's free tier also caps
**per day** where Groq caps only per minute. At the daily cap the site slows
down instead of stopping. The header shows which provider answered — lit green,
pulsing red when rate limited — and the working spinner carries that provider's
mark, so a fallback is visible while it happens.

**The model id lives in `wrangler.jsonc`, not in the source**, because Google
retires ids on their own schedule:

```jsonc
"vars": { "GEMINI_MODEL": "gemini-3.1-flash-lite" }
```

When a retired id returns `404`, Google's error names its replacement; the
worker reads that suggestion and retries once with it, so a retirement heals
itself. `GET https://chat.<domain>/status` reports what each provider is
actually running, whether either is rate limited, and the last failure if there
was one — one KV read, no model call.

A provider that is configured but failing reports `state: "error"` rather than
`"ok"`. That distinction matters: a retired model id once made every Gemini
request fail, the worker fell back to Groq exactly as designed, and the site ran
on a thirtieth of its budget with nothing anywhere saying so.

---

## Setup from a fresh clone

**Prerequisites:** a Cloudflare account with your **domain already added as a
zone** (needed for the `chat.` / `feeds.` custom subdomains), Node + `npm i -g
wrangler && wrangler login`, and at least one model provider account.

1. **Get the keys.** Gemini and/or Groq (at least one), LangSearch (optional).
   Paste them into `.env`.

2. **Create the Turnstile widget.** Cloudflare dashboard → Turnstile → add a
   **Managed** widget whose domains include your site plus `localhost` and
   `127.0.0.1`. It gives a **sitekey** (→ paste into `assets/js/turnstile.js`)
   and a **secret** (→ worker, next step).

3. **Create the rate-limit KV namespace** and copy its id into `wrangler.jsonc`:

   ```sh
   wrangler kv namespace create CHAT_RL
   ```

4. **Deploy the chat worker and push its secrets:**

   ```sh
   wrangler deploy                                   # uses wrangler.jsonc → colaco-chat
   wrangler secret put GEMINI_API_KEY      --name colaco-chat   # primary
   wrangler secret put GROQ_API_KEY        --name colaco-chat   # fallback
   wrangler secret put TURNSTILE_SECRET    --name colaco-chat
   wrangler secret put LANGSEARCH_API_KEY  --name colaco-chat   # optional
   ```

   Then dashboard → the `colaco-chat` worker → Settings → Domains & Routes →
   add custom domain **`chat.<yourdomain>`**.

5. **Deploy the feeds worker:**

   ```sh
   wrangler deploy -c wrangler.feeds.jsonc           # worker is named "feeds"
   ```

   Then add its custom domain **`feeds.<yourdomain>`**.

6. **Point the site at your workers.** In the three client files, change the
   `colaco.se` subdomains to yours, and in both workers set `ALLOWED_ORIGINS`
   to your site's origin:

   - `assets/js/chat.js` → `CHAT_ENDPOINT`
   - `assets/js/turnstile.js` → `VERIFY_ENDPOINT`
   - `assets/js/feeds.js` → `FEED_PROXY`
   - `chat-worker.js` and `feeds-worker.js` → `ALLOWED_ORIGINS`

7. **Enable GitHub Pages.** Repo → Settings → Pages → **Source: GitHub
   Actions**. Every push to `main` now runs the tests and, if they pass,
   deploys via `.github/workflows/static.yml`.

8. **(Optional) weekly email digest.** Cloudflare → Email → **Email Routing** →
   verify a destination address. Put it in `chat-worker.js` (`DIGEST_TO`) and
   `wrangler.jsonc` (`send_email.destination_address`), then redeploy the chat
   worker. Fires Mondays 08:00 UTC. Skip this and nothing else breaks.

9. **(Optional) CI worker deploys.** Add the two GitHub Actions secrets from the
   table above; then editing `chat-worker.js` / `feeds-worker.js` and pushing
   redeploys them automatically.

---

## Tests

Every failure this site has actually shipped is a case in
`tools/regression.mjs` — 40 checks, no model calls, all deterministic:
grounding, follow-up chaining, questions about the site, questions about the
assistant's own state, prepared answers, the commands, provider lights, and
that an upload contacts nobody.

```sh
npm install                       # playwright, for the tests only
npx playwright install chromium
python3 -m http.server 8080 &
npm test                          # node tools/regression.mjs
```

**The Pages workflow runs this before deploying and will not publish if it
fails**, so a fix for one bug cannot quietly reintroduce another. If it ever
blocks an urgent change, drop `needs: test` from `.github/workflows/static.yml`.

`package.json` exists only for this tooling. The site itself ships no
JavaScript dependencies.

---

## Rebuilding the semantic index

The assistant matches rephrased questions with static embeddings from
[Model2Vec](https://github.com/MinishLab/model2vec) (MIT) — a token-to-vector
table, so encoding is a lookup and a mean rather than neural inference. The
table is checked in at `assets/data/embed.{json,bin}`; you do **not** need to
rebuild it to run the site. Rebuild after editing `knowledge/`, so new
vocabulary is covered:

```sh
pip install model2vec numpy
npm run embeddings      # build + verify the JS port matches Python + task accuracy
```

It is ~1.8 MB, pruned from the model's 29,528 tokens to the 7,108 this corpus
can use, fetched lazily on the first keystroke — never at boot — and everything
degrades to lexical search if it fails to load.

Embeddings are used for **ranking**, not for deciding what is answerable.
Measured on this corpus they call document-versus-web at 84% against 100% for
the lexical rules, because topical adjacency ("how does a random forest work")
is not the same as the corpus having the answer.

---

## Layout

```
index.html               terminal shell + every panel's markup
assets/css/
  terminal.css           CRT theme, layout, responsive rules
  components.css         feed / paper / form component styles
assets/js/
  core.js                $, esc, store, timeAgo, toast
  turnstile.js           boot gate: Turnstile challenge → signed pass
  feeds.js               RSS/Atom/JSON engine, Ground News + security desk
  embed.js               static embeddings in the browser (Model2Vec port)
  docconv.js             .txt/.pdf/.docx → Markdown, entirely client-side
  chat.js                retrieval, follow-up detection, the assistant client
  terminal.js            command router, modal manager, boot, uploads
assets/data/             embed.json + embed.bin — the token table
assets/img/valency.jpeg  profile photo
assets/vendor/           pdf.js, mammoth, turndown (see its README);
                         matter.min.js is used only by backup/
knowledge/               documents the assistant may read (+ manifest.json)
publications/            paper PDFs linked from the site
tools/
  regression.mjs         every shipped bug, as a test
  build-embeddings.py    rebuilds the token table
  embed-verify.mjs       proves the JS port matches Python
  embed-eval.mjs         task accuracy of the pruned table
chat-worker.js           → chat.<domain>   (wrangler.jsonc)
feeds-worker.js          → feeds.<domain>  (wrangler.feeds.jsonc)
backup/                  the previous "Liquid Glass" site (also git tag
                         pre-terminal-redesign) — includes the removed games
```

---

## Day-to-day

**Run locally:** `python3 -m http.server 8080`, open <http://localhost:8080>.
Everything works offline except the live feeds and the assistant, which need
their workers reachable and `localhost` in the workers' `ALLOWED_ORIGINS`.

**Deploy the site:** push to `main`. Tests run first; assets are cache-busted
with the commit SHA, so returning visitors never run new HTML against stale JS.

**Deploy a worker:** `wrangler deploy` (chat) or
`wrangler deploy -c wrangler.feeds.jsonc` (feeds) — or let CI do it (step 9).
Worker **secrets and custom domains survive a deploy**; only bindings declared
in the wrangler config are replaced (which is why `CHAT_RL` lives there, not
just in the dashboard).

**Add to the knowledge base:** drop a `.md` file in `knowledge/`, add a line to
`knowledge/manifest.json`, run `npm run embeddings`, push. See
[`knowledge/README.md`](knowledge/README.md).

**Add a prepared answer:** the questions `/fun` suggests are answered from
`knowledge/06-quick-answers.md` with no model call at all. A heading is the
question, and an `*Also asked as: …*` line under it registers other phrasings —
so a new wording is a Markdown edit, not a code change. Anything close enough
is matched semantically anyway.

**Visitor uploads:** `/upload` accepts `.txt`, `.pdf` and `.docx` up to 8 MB,
converts each to Markdown **in the browser**, and searches them ahead of the web
and of `knowledge/`. The file never leaves the machine, and since the converters
are vendored, nothing outside this origin learns an upload happened.

---

## Why the keys aren't in the page

The site is static: anything in `index.html` or `assets/js/` is readable via
View Source, and an API key found that way is billable by whoever finds it. So
the keys live as Worker secrets and the browser talks to `chat.<domain>`, which
adds them server-side. Turnstile gates that endpoint (a single-use token is
exchanged once for a short-lived signed pass), and a per-IP KV rate limit
(30 questions / 10 min) caps abuse.

For the weekly digest, each question is stored for 14 days with its timestamp,
the country Cloudflare reports, and whether the site's own documents matched.
No IP address, no identifier, and nothing linking one question to another.
`/upload` files are never stored at all — they are converted and searched in
the browser and gone on reload.
