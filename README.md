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
      turnstile.js          boot gate: Turnstile challenge, signed pass
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

## How the assistant answers

Retrieval runs first, always. Every question is scored against the chunks in
`knowledge/`; when the corpus has a claim on it, those chunks go up as context
and the model is told to prefer them. When it does not, the model answers from
its own general knowledge instead, and is told to say so.

The terminal labels which happened, so the two are never confused: an answer
grounded in the documents shows `sources:` chips naming them, and one from the
model's own knowledge shows an amber `general knowledge` marker. The citation
list names every document that went up as context — it is a provenance
statement, not a relevance ranking.

Greetings and questions about the assistant itself ("what model are you?") are
answered locally, without an API call.

## Abuse protection

Because the assistant answers general questions, its endpoint is worth abusing
— left open it is a free LLM on the site's Groq quota. Two things stop that:

**Cloudflare Turnstile.** A visitor solves one challenge behind the boot
screen and receives a short-lived signed pass (HMAC over expiry + origin,
12-hour TTL, no server-side storage). Every question carries that pass;
requests without a valid one are refused with 401. Turnstile tokens are
single-use, which is exactly why the pass exists — a token cannot ride along
with each message. Siteverify is called from the worker, never the browser,
and the token must have been solved on the same origin that is calling.

**Per-IP rate limiting.** Bind a KV namespace as `CHAT_RL` on the worker to
enforce it (30 questions per 10 minutes by default):

    wrangler kv namespace create CHAT_RL

Without the binding the worker still runs but does not throttle. Rate limits
are handled gracefully at both ends: the worker forwards Groq's own
`Retry-After`, and the terminal counts the wait down and retries once.

## Running locally

    python3 -m http.server 8080

Then open http://localhost:8080. The feeds need the localhost origins deployed
to the feeds worker (see above); everything else works offline, and the
assistant works as soon as `chat.colaco.se` is up.

## Adding to the knowledge base

See [`knowledge/README.md`](knowledge/README.md). Short version: drop a text
file in `knowledge/`, add a line to `knowledge/manifest.json`, push. No build
step and no embedding job — retrieval is BM25 in the browser.
