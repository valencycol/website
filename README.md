# colaco.se

A personal site shaped like a terminal. Visitors type slash-commands, or ask
an AI assistant a question in plain English. The assistant answers from the
documents in [`knowledge/`](knowledge/); when a question isn't covered there it
falls back to a live web search and cites the links.

It is a **static site on GitHub Pages** plus **two Cloudflare Workers** that
hold the things a static page cannot: API keys, and an allowlisted feed proxy.

```
Browser ──► GitHub Pages (this repo, static)
   │
   ├─► chat.<domain>  (Worker: colaco-chat)  ──► Groq · Turnstile · LangSearch · KV · Email
   └─► feeds.<domain> (Worker: feeds)        ──► RSS / Ground News / CISA (allowlisted)
```

---

## What you need to provide, and where it goes

Three kinds of value. Only the first two are secret.

### 1 · Cloudflare Worker secrets — on the `colaco-chat` worker

Pushed with `wrangler secret put <NAME> --name colaco-chat` (never committed).

| Secret | Needed for | Get it from | If unset |
|---|---|---|---|
| `GROQ_API_KEY` | the AI assistant | <https://console.groq.com/keys> | assistant returns HTTP 500 |
| `TURNSTILE_SECRET` | the bot gate | your Turnstile widget (step 3) | **gate is disabled** — the endpoint is open |
| `LANGSEARCH_API_KEY` | live web search | <https://langsearch.com/dashboard> (free) | out-of-corpus answers use the model's own memory, no web sources |

`GROQ_MODEL` is an optional plain var (not a secret); it defaults to
`openai/gpt-oss-20b` in code.

### 2 · GitHub Actions secrets — repo → Settings → Secrets and variables → Actions

Only needed if you want the workers to **auto-deploy from CI** on push
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
| Worker URLs | `assets/js/chat.js`, `turnstile.js`, `feeds.js` | your `chat.` / `feeds.` subdomains |

> `.env` is **gitignored and read by nothing at runtime.** It is just your
> local scratchpad to paste keys into before running `wrangler secret put`.
> See `.env.example`.

---

## Setup from a fresh clone

**Prerequisites:** a Cloudflare account with your **domain already added as a
zone** (needed for the `chat.` / `feeds.` custom subdomains), Node + `npm i -g
wrangler && wrangler login`, and a Groq account.

1. **Get the keys.** Groq key (required); LangSearch key (optional, web
   search). Paste both into `.env`.

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
   wrangler secret put GROQ_API_KEY       --name colaco-chat
   wrangler secret put TURNSTILE_SECRET   --name colaco-chat
   wrangler secret put LANGSEARCH_API_KEY --name colaco-chat   # optional
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
   Actions**. Every push to `main` now deploys via `.github/workflows/static.yml`.

8. **(Optional) weekly email digest.** Cloudflare → Email → **Email Routing** →
   verify a destination address. Put it in `chat-worker.js` (`DIGEST_TO`) and
   `wrangler.jsonc` (`send_email.destination_address`), then redeploy the
   chat worker. Fires Mondays 08:00 UTC. Skip this and nothing else breaks.

9. **(Optional) CI worker deploys.** Add the two GitHub Actions secrets from
   the table above; then editing `chat-worker.js` / `feeds-worker.js` and
   pushing redeploys them automatically. Without this, deploy workers by hand
   with the commands above.

---

## Make it yours (search-and-replace `colaco.se`)

Beyond the worker URLs in step 6: the contact email and card
(`index.html` — the `formsubmit.co/…`, `mailto:`, `tel:` links),
`canonical` / `og:` meta tags, `DIGEST_FROM`, the worker names in the two
`wrangler.*.jsonc` files if you want different names, and of course the
content under `knowledge/` and the PDFs in `publications/`.

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
  chat.js                in-browser retrieval + the assistant client
  terminal.js            command router, modal manager, boot, uploads
assets/img/valency.jpeg  profile photo
assets/vendor/           matter.min.js (unused; kept for backup restore)
knowledge/               documents the assistant may read (+ manifest.json)
publications/            paper PDFs linked from the site
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

**Deploy the site:** push to `main` (Pages workflow). Assets are cache-busted
with the commit SHA, so returning visitors never run new HTML against stale JS.

**Deploy a worker:** `wrangler deploy` (chat) or
`wrangler deploy -c wrangler.feeds.jsonc` (feeds) — or let CI do it (step 9).
Worker **secrets and custom domains survive a deploy**; only bindings declared
in the wrangler config are replaced (which is why `CHAT_RL` lives there, not
just in the dashboard).

**Add to the knowledge base:** drop a `.md`/`.txt` file in `knowledge/`, add a
line to `knowledge/manifest.json`, push. No build step, no embeddings —
retrieval is BM25 in the browser. See [`knowledge/README.md`](knowledge/README.md).

## Why the keys aren't in the page

The site is static: anything in `index.html` or `assets/js/` is readable via
View Source, and a Groq key found that way is billable by whoever finds it. So
the keys live as Worker secrets and the browser talks to `chat.<domain>`,
which adds them server-side. Turnstile gates that endpoint (a single-use token
is exchanged once for a short-lived signed pass), and a per-IP KV rate limit
(30 questions / 10 min) caps abuse.
