# colaco.se

A personal site shaped like a terminal. Visitors type slash-commands, or ask
the AI assistant a question in plain English — and the assistant answers only
from the documents in [`knowledge/`](knowledge/).

Static site on GitHub Pages, plus two Cloudflare Workers that hold the things
a static site cannot: an allowlisted feed proxy, and the Groq API key.

## Layout

    index.html              the terminal shell + every panel's markup
    assets/css/
      terminal.css          the CRT theme, layout, responsive rules
      components.css        feed / game / paper components carried over
    assets/js/
      core.js               $, esc, store, timeAgo, toast
      feeds.js              RSS/Atom/JSON engine, Ground News parser, security desk
      games.js              the six games
      chat.js               retrieval + Groq client
      terminal.js           command router, modal manager, boot, uploads
    assets/img/valency.jpeg profile photo (local copy)
    knowledge/              everything the assistant may read
    feeds-worker.js         → feeds.colaco.se
    chat-worker.js          → chat.colaco.se
    backup/                 the previous "Liquid Glass" site, kept intact

The previous design is also tagged in git as `pre-terminal-redesign`.

See [PREVIEW.md](PREVIEW.md) for previewing a branch before it goes live.

## Deploying

The **site** deploys itself: push to `main` and the Pages workflow in
`.github/workflows/static.yml` publishes the repo root.

The **assistant** needs its Worker deployed once:

    npm i -g wrangler && wrangler login
    wrangler deploy chat-worker.js --name colaco-chat
    wrangler secret put GROQ_API_KEY --name colaco-chat     # paste from .env

Then in the Cloudflare dashboard, open the `colaco-chat` worker →
Settings → Domains & Routes → add the custom domain `chat.colaco.se`.

Optional per-IP rate limiting:

    wrangler kv namespace create CHAT_RL

then bind it as `CHAT_RL` under Settings → Variables & Bindings. Without the
binding the worker still runs; it just doesn't rate-limit.

The **feeds** worker is already deployed. Redeploy it only if you want the
localhost origins (added for local development) to take effect:

    wrangler deploy feeds-worker.js --name colaco-feeds

## Why the API key is not in the page

This site is static. Anything in `index.html` or `assets/js/` is readable by
anyone who opens View Source, and a Groq key found that way is billable by
whoever found it. So the key lives as a Worker secret and the browser talks to
`chat.colaco.se`, which adds the key server-side. `.env` is gitignored and is
only your local copy for `wrangler secret put`.

## How the assistant stays on topic

Two independent guards:

1. **Retrieval.** Every question is scored against the chunks in `knowledge/`.
   If the question's content words don't appear in the corpus at all, the
   terminal declines locally and never calls the API. Measured on a 28-question
   battery: 0/16 in-scope questions wrongly declined, 11/12 out-of-scope caught.

2. **The system prompt** in `chat-worker.js`, built server-side so a crafted
   request cannot replace it. The model is told the retrieved context is its
   entire world, and to decline anything it cannot ground in that context. This
   is the real boundary — guard 1 is a cost optimisation in front of it.

## Running locally

    python3 -m http.server 8080

Then open http://localhost:8080. The feeds need the localhost origins deployed
to the feeds worker (see above); everything else works offline, and the
assistant works as soon as `chat.colaco.se` is up.

## Adding to the knowledge base

See [`knowledge/README.md`](knowledge/README.md). Short version: drop a text
file in `knowledge/`, add a line to `knowledge/manifest.json`, push. No build
step and no embedding job — retrieval is BM25 in the browser.
