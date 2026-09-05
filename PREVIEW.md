# Previewing `terminal_edition`

Three ways, cheapest first. The thing to know up front:

> **GitHub Pages has exactly one deployment per repository.** There is no
> branch-preview feature. Deploying `terminal_edition` to Pages *replaces*
> what is live at colaco.se until you deploy `main` again. If you want a
> preview URL that does not touch production, use option 3.

Whichever you pick, the chat and feed workers must recognise the origin you
open the site from, or the assistant returns `origin not allowed` and the
feeds fail CORS. Both workers already allow: `colaco.se`, `www.colaco.se`,
`valencycol.github.io`, and `localhost` / `127.0.0.1` on any port.

---

## 1. Locally — fastest, full functionality

```sh
git checkout terminal_edition
python3 -m http.server 8080
```

Open <http://localhost:8080>. Everything works: commands, modals, games,
uploads, and the assistant.

Two one-time prerequisites for the live parts:

```sh
# the assistant
wrangler deploy chat-worker.js --name colaco-chat
wrangler secret put GROQ_API_KEY --name colaco-chat     # paste from .env
#   …then add chat.colaco.se as a custom domain in the dashboard

# the feeds — redeploy so it accepts localhost
wrangler deploy -c wrangler.feeds.jsonc          # the worker is named "feeds"
```

Until the feeds worker is redeployed, `/news` and `/cybersecurity-news` will
show their error panel locally. Everything else is unaffected.

---

## 2. On GitHub Pages — a real URL, but it replaces the live site

The existing workflow already has `workflow_dispatch`, and `actions/checkout`
checks out whichever branch you dispatch. So:

```sh
git push -u origin terminal_edition
```

Then: **GitHub → Actions → "Deploy static content to Pages" → Run workflow →
Branch: `terminal_edition` → Run**.

Roughly a minute later the new site is at colaco.se — and at
<https://valencycol.github.io/website/>, which is why that origin is on the
worker allowlist. The assistant works immediately, since `colaco.se` was
already allowed.

**To put the old site back**, run the same workflow again with Branch: `main`.
Nothing is lost either way — the branches are untouched by deploying.

Use this when you want to look at the real thing on a phone and don't mind the
live site being the new one for a few minutes.

---

## 3. On Cloudflare Pages — proper previews, production untouched  ← recommended

You already have a Cloudflare account for the two workers, and Pages gives
every branch its own URL automatically.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**
2. Pick `valencycol/website`. Production branch: `main`.
3. Build settings: **framework preset `None`**, build command **empty**,
   output directory **`/`**. It's a static site; there is nothing to build.
4. Deploy.

From then on, every branch you push gets
`https://<branch>.<project>.pages.dev` — so `terminal_edition` becomes
`https://terminal-edition.<project>.pages.dev`, and `main` stays live at
colaco.se untouched.

One edit is needed to let the assistant answer from those URLs. In **both**
`chat-worker.js` and `feeds-worker.js`, set your project name:

```js
const CF_PAGES_PROJECT = 'your-pages-project-name';
```

then redeploy both workers. That allowlists `<project>.pages.dev` and
`<branch>.<project>.pages.dev` — and nothing else. It is deliberately not a
bare `*.pages.dev` wildcard: that would let anyone with a Pages project spend
your Groq quota.

---

## Merging back into `main`

Once you're happy:

```sh
git checkout main
git merge terminal_edition
git push
```

Pushing to `main` triggers the Pages workflow on its own, so colaco.se updates
without any manual step.

Prefer a pull request? Push the branch and open one on GitHub — the diff is
worth a read, since the redesign moved a 173 KB single file into modules.

### If you want to go back afterwards

The previous site is kept two ways:

```sh
git checkout pre-terminal-redesign -- index.html   # restore just the old page
```

and `backup/index.liquid-glass.html` is a plain copy you can open directly.
