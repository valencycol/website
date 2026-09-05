/* ============================================================
   Feed engine — fetches RSS/Atom/JSON/HTML through the first-party
   Cloudflare Worker at feeds.colaco.se (allowlisted upstreams,
   edge-cached, serves the last good copy if an upstream is down).
   ============================================================ */
const FEED_PROXY = 'https://feeds.colaco.se/?url=';
/* maxAge (seconds, optional) asks the worker to revalidate anything older;
   clamped server-side to [60, 86400]. Omit it to use the worker default. */
const viaProxy = (u, maxAge) =>
  FEED_PROXY + encodeURIComponent(u) + (maxAge ? '&max_age=' + maxAge : '');

const RELAYS = [
  { name: 'worker', raw: true, build: u => viaProxy(u), parse: parseFeed }
];

/* Fetch one URL through a single relay, with its own timeout. An external
   AbortSignal lets a winning racer cancel the losers so the browser stops
   doing work that's no longer needed. */
async function relayFetch(build, url, externalSignal, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(build(url), { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!text || text.length < 40) throw new Error('Empty response');
    return text;
  } finally {
    clearTimeout(t);
    if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
  }
}

/* Fetch plain text through the worker with a timeout. Used for the CISA
   KEV JSON (which isn't a feed, so parseFeed doesn't apply). */
  
async function fetchText(url, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  const race = new AbortController();
  const attempts = RELAYS.filter(r => r.raw).map(r => relayFetch(r.build, url, race.signal, timeoutMs));
  try {
    const text = await Promise.any(attempts);
    race.abort(); /* cancel the losers */
    return text;
  } catch (e) {
    race.abort();
    throw new Error('All relays failed for ' + url);
  }
}

function pick(el, names) {
  for (const n of names) {
    const found = el.getElementsByTagName(n)[0];
    if (found && found.textContent) return found.textContent.trim();
  }
  return '';
}

/* Resolve + validate an image URL. https only, to avoid mixed-content
   blocking on a secure site; relative URLs resolve against the feed/link. */
function resolveImgUrl(url, base) {
  if (!url) return '';
  try {
    const u = new URL(url.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.href;
  } catch (e) { return ''; }
}

/* Pull a thumbnail out of media/enclosure tags, falling back to the first
   <img> embedded in the description/content HTML. */
function extractImage(node, base) {
  const tags = ['media:thumbnail', 'media:content', 'enclosure', 'media:group'];
  for (const t of tags) {
    const els = node.getElementsByTagName(t);
    for (const el of Array.from(els)) {
      const url = (el.getAttribute('url') || el.getAttribute('href') || '').trim();
      if (!url) continue;
      const type = (el.getAttribute('type') || el.getAttribute('medium') || '').toLowerCase();
      const isImage = !type || type.indexOf('image') === 0 || type === 'img';
      if (!isImage) continue;
      const resolved = resolveImgUrl(url, base);
      if (resolved) return resolved;
    }
  }
  for (const descTag of ['description', 'content:encoded', 'content', 'summary']) {
    const el = node.getElementsByTagName(descTag)[0];
    if (!el || !el.textContent) continue;
    const m = el.textContent.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m && m[1]) {
      const resolved = resolveImgUrl(m[1], base);
      if (resolved) return resolved;
    }
  }
  return '';
}

function parseFeed(xmlText, source) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Bad XML from ' + source.name);
  let nodes = Array.from(doc.getElementsByTagName('item'));       /* RSS  */
  let atom = false;
  if (!nodes.length) { nodes = Array.from(doc.getElementsByTagName('entry')); atom = true; } /* Atom */
  return nodes.map(node => {
    let link = '';
    if (atom) {
      const links = Array.from(node.getElementsByTagName('link'));
      const alt = links.find(l => (l.getAttribute('rel') || 'alternate') === 'alternate') || links[0];
      link = alt ? (alt.getAttribute('href') || '') : '';
    } else {
      link = pick(node, ['link', 'guid']);
    }
    const base = link || source.url;
    const dateStr = pick(node, ['pubDate', 'published', 'updated', 'dc:date', 'date']);
    return {
      title: stripHtml(pick(node, ['title'])),
      link: link.trim(),
      date: dateStr ? new Date(dateStr) : new Date(0),
      desc: stripHtml(pick(node, ['description', 'summary', 'content'])).slice(0, 260),
      img: extractImage(node, base),
      source: source.name,
      color: source.color
    };
  }).filter(it => it.title && it.link);
}

/* Fetch + parse one source, racing relays so the first VALID feed wins
   (a fast relay returning an HTML error page can't beat a slower good one,
   because parsing/item-count is part of the race). */
async function loadSource(src, perSource, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  const race = new AbortController();
  const attempts = RELAYS.map(relay =>
    relayFetch(relay.build, src.url, race.signal, timeoutMs).then(txt => {
      const items = relay.parse(txt, src).slice(0, perSource);
      if (!items.length) throw new Error('No items from ' + src.name);
      return items;
    })
  );
  try {
    const items = await Promise.any(attempts);
    race.abort(); /* cancel the losers */
    return items;
  } catch (e) {
    race.abort();
    throw e;
  }
}

/* Merge + de-duplicate + cap a batch of feed items, newest first. */
function mergeItems(arr, cap) {
  const seen = new Set();
  return arr.slice()
    .sort((a, b) => b.date - a.date)
    .filter(it => {
      const key = it.title.toLowerCase().slice(0, 90);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, cap);
}

/* Load every source, but render progressively: as soon as a source resolves
   its items are merged and onPartial fires, so the user sees results in ~1–2s
   instead of waiting for the slowest source. A soft deadline stops the
   skeletons/blank state even if some sources never come back. */
async function loadSources(sources, perSource, cap, opts) {
  const o = opts || {};
  const softDeadline = o.softDeadline || 4500;
  const perTimeout = o.timeout || 8000;
  const status = sources.map(() => 'pending');
  const collected = [];
  let pending = sources.length;
  let finalized = false;

  const emit = () => {
    if (!o.onPartial) return;
    const failed = sources.filter((_, i) => status[i] !== 'ok').map(s => s.name);
    o.onPartial(mergeItems(collected, cap), failed);
  };

  const allSettled = new Promise(resolve => {
    sources.forEach((src, i) => {
      loadSource(src, perSource, perTimeout).then(its => {
        status[i] = 'ok';
        collected.push(...its);
        if (!finalized) emit();
      }).catch(() => {
        status[i] = 'fail';
        if (!finalized) emit();
      }).finally(() => { if (--pending === 0) resolve(); });
    });
  });

  let timedOut = false;
  const deadline = new Promise(r => setTimeout(() => { timedOut = true; r(); }, softDeadline));
  await Promise.race([allSettled, deadline]);

  if (timedOut && pending > 0) {
    /* Don't keep the user waiting on stragglers; mark them unreachable for now. */
    sources.forEach((s, i) => { if (status[i] === 'pending') status[i] = 'fail'; });
    emit();
  }
  finalized = true;

  if (!collected.length) throw new Error('No feeds reachable');
  const failed = sources.filter((_, i) => status[i] !== 'ok').map(s => s.name);
  return { items: mergeItems(collected, cap), failed };
}

/* ---------- rendering ---------- */
function skeletons(el, n) {
  el.innerHTML = Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

function errorPanel(el, retryFn, extra) {
  el.innerHTML =
    '<div class="error-panel glass">' +
      '<p><strong>Couldn\u2019t reach the live feeds from here.</strong><br>' + esc(extra || '') +
      ' This usually happens in sandboxed previews \u2014 the feeds load normally once the site is hosted (or opened directly in a browser).</p>' +
      '<button class="btn primary" id="retry-btn">Try again</button>' +
    '</div>';
  $('#retry-btn', el).addEventListener('click', retryFn);
}

function renderItems(el, items, opts) {
  const o = opts || {};
  el.innerHTML = items.map(it => {
    const cve = it.cve ? '<span class="cve-id">' + esc(it.cve) + '</span>' : '';
    const thumb = it.img
      ? '<div class="feed-thumb-wrap"><img class="feed-thumb" src="' + esc(it.img) +
        '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>'
      : '';
    return (
      '<article class="feed-item glass' + (it.img ? ' has-thumb' : '') + '">' +
        thumb +
        '<div class="feed-meta">' +
          '<span class="src-chip"><i style="--c:' + esc(it.color) + '"></i>' + esc(it.source) + '</span>' +
          cve +
          '<span>' + esc(timeAgo(it.date)) + '</span>' +
        '</div>' +
        '<h3><a href="' + esc(it.link) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a></h3>' +
        (it.desc ? '<p class="snippet">' + esc(it.desc) + '</p>' : '') +
        '<div class="row">' +
          '<a class="chip-link" target="_blank" rel="noopener" href="' + esc(it.link) + '">Read the story ↗</a>' +
        '</div>' +
      '</article>'
    );
  }).join('');
  /* Per-image cleanup (generation-safe: each timer closes over its own img,
     so a later render can't be touched by an earlier render's timer). */
  el.querySelectorAll('.feed-thumb').forEach(img => {
    const wrap = img.parentNode;
    const timer = setTimeout(() => {
      if (img.isConnected && !img.classList.contains('loaded') && wrap) wrap.remove();
    }, 8000);
    img.addEventListener('load', () => { clearTimeout(timer); img.classList.add('loaded'); }, { once: true });
    img.addEventListener('error', () => { clearTimeout(timer); if (wrap) wrap.remove(); }, { once: true });
  });
  if (items._failed && items._failed.length) {
    el.insertAdjacentHTML('beforeend',
      '<p class="feed-note">Temporarily unreachable: ' + esc(items._failed.join(', ')) + '</p>');
  }
}

function parseDateMs(s) {
  if (!s) return null;
  const t = Date.parse(s);
  if (isNaN(t)) return null;
  /* reject implausible values: before 2000 or more than 5 min in the future */
  if (t < 946684800000) return null;
  if (t > Date.now() + 300000) return null;
  return t;
}

/* ============================================================
   Ground News — top stories with left / center / right bias
   ============================================================ */
/* Ground News has no public RSS/API, so we read its server-rendered
   homepage (Next.js / React Server Components). The top-story data —
   title, publish time, description, thumbnail, and the full left/center/
   right bias breakdown — is embedded inside self.__next_f.push(...) flight
   chunks as escaped JSON. We decode those chunks, then walk each story's
   blindspotData segment. */
function parseGroundNews(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { chunks.push(JSON.parse('"' + m[1] + '"')); } catch (e) {}
  }
  const flight = chunks.join('');
  const g = (rx, s, grp) => { const x = rx.exec(s); return x ? x[grp || 1] : null; };
  const bIdx = [];
  let from = 0;
  while (true) {
    const i = flight.indexOf('blindspotData', from);
    if (i < 0) break;
    bIdx.push(i);
    from = i + 1;
  }
  const slugify = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const clean = t => String(t == null ? '' : t)
    .replace(/\\u0027/g, "'").replace(/\u0027/g, "'")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
  const stories = [];
  for (let k = 0; k < bIdx.length; k++) {
    const start = bIdx[k];
    const end = k + 1 < bIdx.length ? bIdx[k + 1] : flight.length;
    const seg = flight.slice(start, Math.min(end, start + 16000));
    const left = +g(/leftPercent":(\d+)/, seg) || 0;
    const center = +g(/centerPercent":(\d+)/, seg) || 0;
    const right = +g(/rightPercent":(\d+)/, seg) || 0;
    if (!left && !center && !right) continue;
    let title = g(/"start":"[^"]+","title":"((?:[^"\\]|\\.)*)"/, seg);
    if (!title) title = g(/"generatedHeadline":"((?:[^"\\]|\\.)*)"/, seg);
    if (!title || title.length < 10) continue;
    const slug = g(/"start":"[^\"]+","title":"(?:[^\"\\]|\\.)*","slug":"([^\"]+)"/, seg);
    const uids = flight.slice(Math.max(0, start - 300), start).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
    const sid = uids && uids.length ? uids[uids.length - 1] : '';
    /* Freshness: the story's own `start` is the coverage-window start (often
       hours old). Each source article in the segment also carries a `date`
       (when that outlet published). We take the newest valid publish date —
       the most recent coverage activity — so the "X hours ago" label reflects
       the latest reporting, not when the story first began. */
    const dateStr = g(/"start":"([^"]+)"/, seg);
    let latestMs = dateStr ? parseDateMs(dateStr) : 0;
    if (latestMs != null) {
      let dmo;
      const dre = /"date":"([0-9T:.\-+Z]+)"/g;
      while ((dmo = dre.exec(seg)) !== null) {
        const ms = parseDateMs(dmo[1]);
        if (ms != null && ms > latestMs) latestMs = ms;
      }
    }
    const desc = g(/"description":"((?:[^"\\]|\\.)*)"/, seg);
    const img = g(/"fallbackMedia":\{"url":"([^"]+)"/, seg)
             || g(/"url":"(https:\/\/groundnews[^"]+\/assets\/[^"]+)"/, seg);
    const blindspotFor = g(/"blindspotFor":"([^"]+)"/, seg);
    const profile = g(/"coverageProfileStatement":"((?:[^"\\]|\\.)*)"/, seg);
    const lSrc = +g(/leftSrcCount":(\d+)/, seg) || 0;
    const cSrc = +g(/cntrSrcCount":(\d+)/, seg) || 0;
    const rSrc = +g(/rightSrcCount":(\d+)/, seg) || 0;
    stories.push({
      title: clean(title),
      link: slug ? 'https://ground.news/article/' + slug : (sid ? 'https://ground.news/article/' + sid : 'https://ground.news/'),
      date: latestMs != null ? new Date(latestMs) : new Date(),
      desc: desc ? clean(stripHtml(desc)).slice(0, 240) : '',
      img: img || '',
      bias: { left: left, center: center, right: right },
      src: { left: lSrc, center: cSrc, right: rSrc, total: lSrc + cSrc + rSrc },
      blindspot: blindspotFor || '',
      profile: profile ? clean(stripHtml(profile)) : ''
    });
  }
  const seen = new Set();
  const uniq = [];
  for (const s of stories) {
    /* dedup by headline, not link: the same story appears in several
       flight segments and its slug/UUID sometimes resolves differently
       between them, so keying on the link lets duplicates through */
    const key = slugify(s.title).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(s);
  }
  uniq.sort((a, b) => b.date - a.date);
  return uniq.slice(0, 12);
}

/* Fetch Ground News through the first-party worker, accepting only a
   response that actually contains the story data (rejects challenge /
   error pages).

   Freshness is negotiated with the worker via max_age: background loads
   accept an edge-cached copy up to 5 minutes old (fast, cheap, resilient);
   a manual Refresh insists on ≤60s, the tightest the worker allows. Either
   way the worker serves its last good copy if ground.news itself is down. */
async function fetchGroundNews(force) {
  const maxAge = force ? 60 : 300;
  /* Two Ground News pages carry the blindspot story data: the homepage
     (2.6MB, freshest, most stories) and /blindspot (410KB, smaller and
     quicker). We prefer the homepage — giving it a short head start — but
     let the smaller page join as a fallback so the feed always renders. */
  const grab = (target, timeoutMs) =>
    relayFetch(u => viaProxy(u, maxAge), target, null, timeoutMs).then(html => {
      if (!html || html.indexOf('blindspotData') < 0) throw new Error('Not Ground News content');
      return html;
    });
  /* Homepage first, always. It carries the freshest and most complete
     top-stories data. /blindspot is smaller and quicker but holds
     under-covered — and therefore older — stories, so it must never win a
     race and serve staler content. It is a fallback for when the homepage
     genuinely fails (and the worker's stale-cache copy also can't be had),
     nothing more. */
  try {
    return await grab('https://ground.news/', 14000);
  } catch (e) {
    return await grab('https://ground.news/blindspot', 12000);
  }
}

function renderGroundItems(el, items) {
  /* Strict newest-first, unconditionally — Ground News ranks its homepage by
     coverage/importance, not time, so the raw order can lead with an older
     but heavily-covered story. Sort by each story's latest coverage date so
     the freshest always leads. */
  items = items.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  el.innerHTML = items.map(it => {
    const thumb = it.img
      ? '<div class="feed-thumb-wrap"><img class="feed-thumb" src="' + esc(it.img) +
        '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></div>'
      : '';
    const b = it.bias, s = it.src;
    const blindspot = it.blindspot
      ? '<span class="blindspot-badge" title="' + esc(it.profile || '') + '">Blindspot · under-covered by ' +
        esc(it.blindspot.charAt(0).toUpperCase() + it.blindspot.slice(1)) + '</span>'
      : '';
    const biasBar =
      '<div class="bias-bar" title="Left ' + b.left + '% · Center ' + b.center + '% · Right ' + b.right + '%">' +
        (b.left   ? '<div class="bias-seg bias-left"   style="width:' + b.left   + '%"><span>L ' + b.left   + '%</span></div>' : '') +
        (b.center ? '<div class="bias-seg bias-center" style="width:' + b.center + '%"><span>C ' + b.center + '%</span></div>' : '') +
        (b.right  ? '<div class="bias-seg bias-right"  style="width:' + b.right  + '%"><span>R ' + b.right  + '%</span></div>' : '') +
      '</div>';
    const legend = '<div class="bias-legend">' +
      '<span class="bl bl-left">Left ' + s.left + '</span>' +
      '<span class="bl bl-center">Center ' + s.center + '</span>' +
      '<span class="bl bl-right">Right ' + s.right + '</span>' +
      (s.total ? '<span class="bl-total">' + s.total + ' sources</span>' : '') +
    '</div>';
    return (
      '<article class="feed-item glass' + (it.img ? ' has-thumb' : '') + '">' +
        thumb +
        '<div class="feed-meta">' +
          '<span class="src-chip"><i style="--c:#5b8cff"></i>Ground News</span>' +
          blindspot +
          '<span>' + esc(timeAgo(it.date)) + '</span>' +
        '</div>' +
        '<h3><a href="' + esc(it.link) + '" target="_blank" rel="noopener">' + esc(it.title) + '</a></h3>' +
        (it.desc ? '<p class="snippet">' + esc(it.desc) + '</p>' : '') +
        biasBar + legend +
        '<div class="row"><a class="chip-link" target="_blank" rel="noopener" href="' + esc(it.link) + '">Read full coverage on Ground News ↗</a></div>' +
      '</article>'
    );
  }).join('');
  el.querySelectorAll('.feed-thumb').forEach(img => {
    const wrap = img.parentNode;
    const timer = setTimeout(() => {
      if (img.isConnected && !img.classList.contains('loaded') && wrap) wrap.remove();
    }, 8000);
    img.addEventListener('load', () => { clearTimeout(timer); img.classList.add('loaded'); }, { once: true });
    img.addEventListener('error', () => { clearTimeout(timer); if (wrap) wrap.remove(); }, { once: true });
  });
}

const News = {
  loaded: false,
  loading: false,
  async load(force) {
    if (this.loading) return;
    const el = $('#news-feed');
    const freshEl = $('#news-fresh');
    let cached = store.get('cache.ground.v2', null);
    /* Migrate the previous cache schema so a fresh visit still shows the
       last good batch while the relays are retried in the background. */
    if (!cached) cached = store.get('cache.ground', null);
    const FRESH = 2 * 60 * 1000;
    /* Report the age of the newest STORY, not when we fetched. The worker can
       serve a stale edge copy (Ground News blocked at some Cloudflare PoPs)
       while "just now" would wrongly imply the news is current. */
    const STALE = 90 * 60 * 1000;   // Ground News refreshes ~hourly; older than this is stale
    const newestMs = its => its && its.length
      ? Math.max.apply(null, its.map(x => +new Date(x.date)).filter(n => n > 0)) : 0;
    const setFresh = (t, status, items) => {
      if (!freshEl) return;
      if (!t && status !== 'loading') { freshEl.textContent = ''; freshEl.classList.remove('stale'); return; }
      if (status === 'loading') { freshEl.textContent = 'Fetching latest stories\u2026'; freshEl.classList.add('stale'); return; }
      const top = newestMs(items);
      const old = top && (Date.now() - top > STALE);
      let s;
      if (status === 'failed') s = 'Top story ' + timeAgo(new Date(top || t)) + ' \u00b7 refresh failed';
      else if (top) s = 'Top story ' + timeAgo(new Date(top)) + (status === 'retrying' ? ' \u00b7 retrying' : '');
      else s = 'Updated ' + timeAgo(new Date(t));
      freshEl.classList.toggle('stale', old || status === 'retrying' || status === 'failed');
      freshEl.textContent = s;
    };
    if (cached && cached.items) {
      const items = cached.items.map(it => Object.assign({}, it, { date: new Date(it.date) }));
      renderGroundItems(el, items);
      this.loaded = true;
      setFresh(cached.t, Date.now() - cached.t > FRESH ? 'retrying' : null, items);
      if (!force && Date.now() - cached.t < FRESH) return;
    } else {
      setFresh(0);
    }
    this.loading = true;
    if (!cached) { skeletons(el, 6); setFresh(Date.now(), 'loading'); }
    /* Public CORS relays are flaky, so race them and retry a couple of
       times \u2014 a transient failure shouldn't strand the visitor on a
       stale batch for hours. */
    let html = null, lastErr = null;
    for (let attempt = 0; attempt < 3 && !html; attempt++) {
      try { html = await fetchGroundNews(force); }
      catch (e) { lastErr = e; if (attempt < 2) await new Promise(r => setTimeout(r, 900)); }
    }
    try {
      if (!html) throw lastErr || new Error('no data');
      const items = parseGroundNews(html);
      if (items.length < 3) throw new Error('Only ' + items.length + ' stories parsed');
      renderGroundItems(el, items);
      store.set('cache.ground.v2', {
        t: Date.now(),
        items: items.map(it => Object.assign({}, it, { date: it.date.toISOString() }))
      });
      this.loaded = true;
      setFresh(Date.now(), null, items);

      /* If the freshest story is well past Ground News's hourly cadence, the
         worker likely handed us a stale edge copy. Force one cache-bypassing
         refetch (max_age=60) to make it try Ground News again. Once only. */
      const top = newestMs(items);
      if (!force && top && Date.now() - top > 2 * 60 * 60 * 1000 && !this._recovering) {
        this._recovering = true;
        this.loading = false;
        setTimeout(() => this.load(true), 300);
        return;
      }
      this._recovering = false;
    } catch (e) {
      if (!cached) {
        el.innerHTML =
          '<div class="error-panel glass">' +
            '<p><strong>Ground News is temporarily unreachable.</strong><br>' +
            'The live bias feed couldn\u2019t load just now \u2014 usually a short hiccup with the public relay. ' +
            'Try again, or reload the page.</p>' +
            '<button class="btn primary" id="gn-retry">Try again</button>' +
            ' <a class="btn ghost" href="https://ground.news/" target="_blank" rel="noopener">Open Ground News \u2197</a>' +
          '</div>';
        const r = $('#gn-retry');
        if (r) r.addEventListener('click', () => this.load(true));
        setFresh(0);
      } else {
        /* keep showing the cached batch, but flag that the refresh failed */
        setFresh(cached.t, 'failed', cached.items ? cached.items.map(it => Object.assign({}, it, { date: new Date(it.date) })) : null);
      }
    }
    this.loading = false;
  }
};

/* ============================================================
   Cybersecurity desk
   ============================================================ */
const SEC_NEWS_SOURCES = [
  { name: 'The Hacker News',  color: '#ff6b9d', url: 'https://feeds.feedburner.com/TheHackersNews' },
  { name: 'Krebs on Security',color: '#3fe0c5', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'SecurityWeek',     color: '#ffd166', url: 'https://www.securityweek.com/feed/' }
];
const SEC_ADVISORY_SOURCES = [
  { name: 'CISA Advisories', color: '#3fe0c5', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' }
];
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

const Sec = {
  tab: 'news',
  cache: {},
  times: {},
  reqId: 0,
  init() {
    $$('#panel-security .tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#panel-security .tabs button').forEach(b => b.classList.toggle('active', b === btn));
        this.tab = btn.dataset.tab;
        this.load();
      });
    });
  },
  /* freshness indicator mirroring the Ground News `news-fresh` chip */
  setFresh(t, status) {
    const el = $('#sec-fresh');
    if (!el) return;
    if (!t && status !== 'loading') { el.textContent = ''; el.classList.remove('stale'); return; }
    if (status === 'loading') { el.textContent = 'Fetching latest intel\u2026'; el.classList.add('stale'); return; }
    let s = 'Updated ' + timeAgo(new Date(t));
    if (status === 'retrying') s += ' \u00b7 retrying';
    else if (status === 'failed') s = 'Cached ' + timeAgo(new Date(t)) + ' \u00b7 refresh failed';
    el.classList.toggle('stale', status === 'retrying' || status === 'failed');
    el.textContent = s;
  },
  async load(force) {
    const el = $('#sec-feed');
    const tab = this.tab;
    const cached = this.cache[tab];
    if (!force && cached) { renderItems(el, cached); this.setFresh(this.times[tab], null); return; }
    const token = ++this.reqId;
    skeletons(el, 6);
    this.setFresh(Date.now(), 'loading');
    const alive = () => token === this.reqId && this.tab === tab;
    try {
      let items;
      if (tab === 'kev') {
        items = await this.loadKev();
        if (alive()) { this.cache[tab] = items; this.times[tab] = Date.now(); renderItems(el, items); this.setFresh(this.times[tab], null); }
      } else {
        const sources = tab === 'advisories' ? SEC_ADVISORY_SOURCES : SEC_NEWS_SOURCES;
        const onPartial = (partial, failed) => {
          if (!alive()) return;
          partial._failed = failed;
          renderItems(el, partial);
        };
        const res = await loadSources(sources, tab === 'advisories' ? 15 : 8, 18, { onPartial });
        items = res.items;
        items._failed = res.failed;
        this.cache[tab] = items;
        this.times[tab] = Date.now();
        if (alive()) { renderItems(el, items); this.setFresh(this.times[tab], null); }
      }
    } catch (e) {
      if (alive()) { errorPanel(el, () => this.load(true), ''); this.setFresh(this.times[tab] || 0, 'failed'); }
    }
  },
  async loadKev() {
    const raw = await fetchText(KEV_URL, 12000);
    const data = JSON.parse(raw);
    const vulns = (data.vulnerabilities || [])
      .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))
      .slice(0, 14);
    return vulns.map(v => ({
      title: (v.vendorProject ? v.vendorProject + ' ' : '') + (v.product ? v.product + ' — ' : '') + (v.vulnerabilityName || v.cveID),
      link: 'https://nvd.nist.gov/vuln/detail/' + encodeURIComponent(v.cveID),
      date: new Date(v.dateAdded),
      desc: (v.shortDescription || '').slice(0, 260) + (v.requiredAction ? ' Required action: ' + v.requiredAction : ''),
      source: 'CISA KEV',
      color: '#ff5d5d',
      cve: v.cveID
    }));
  }
};

