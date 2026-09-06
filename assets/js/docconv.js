'use strict';
/* ============================================================
   Document → Markdown, entirely in the browser

   The obvious tool here is Microsoft's markitdown, and it cannot run:
   it is Python, and it depends on magika, which depends on onnxruntime,
   for which no pure-Python wheel exists — micropip fails on it under
   Pyodide. The alternative, converting server-side, would mean
   uploading the visitor's file to a machine we control, and this site
   promises the opposite: files added with /upload never leave the
   browser. Privacy wins over convenience.

   So the pipeline markitdown itself uses is reassembled from
   open-source JavaScript that runs client-side:

     .docx -> mammoth (BSD-2) -> HTML -> turndown (MIT) -> Markdown
     .pdf  -> pdf.js (Apache-2.0) text extraction        -> Markdown
     .txt  -> passed through unchanged

   markitdown converts .docx the same way (HTML, then markdownify) and
   .pdf the same way (a text extractor, pdfminer.six). The libraries
   load on first upload, so a visitor who never uploads pays nothing.
   ============================================================ */

const UPLOAD_EXT  = /\.(txt|pdf|docx)$/i;
const MAX_UPLOAD  = 8 * 1024 * 1024;

/* Served from this origin rather than a CDN. Beyond removing a third-party
   dependency, it closes a hole in the promise /upload makes: fetching the
   converter from cdnjs told cdnjs that somebody on this site had just opened a
   PDF. Now nothing outside colaco.se learns that an upload happened.
   Licences are recorded in assets/vendor/README.md. */
const CONV_LIB = {
  pdf:       'assets/vendor/pdf.min.mjs',
  pdfWorker: 'assets/vendor/pdf.worker.min.mjs',
  mammoth:   'assets/vendor/mammoth.browser.min.js',
  turndown:  'assets/vendor/turndown.min.js',
};

/* Stamp local assets with the page's own cache-busting version, as embed.js
   does, so a redeploy cannot serve a stale converter beside fresh scripts. */
function convUrl(path) {
  if (/^https?:/i.test(path)) return path;
  const tag = document.querySelector('script[src*="docconv.js"]');
  const v = ((tag && tag.getAttribute('src')) || '').match(/\?v=([a-z0-9]+)/);
  /* Resolved against the page, not left relative: dynamic import() treats
     "assets/..." as a BARE module specifier and refuses it, and pdf.js wants
     an absolute URL for its worker. */
  return new URL(path + (v ? '?v=' + v[1] : ''), document.baseURI).href;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-conv="' + src + '"]');
    if (existing) {
      if (existing.dataset.ready) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('could not load ' + src)));
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.dataset.conv = src;
    el.onload  = () => { el.dataset.ready = '1'; resolve(); };
    el.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(el);
  });
}

const DocConv = {
  _pdfjs: null,

  async pdfjs() {
    if (this._pdfjs) return this._pdfjs;
    const mod = await import(convUrl(CONV_LIB.pdf));
    mod.GlobalWorkerOptions.workerSrc = convUrl(CONV_LIB.pdfWorker);
    this._pdfjs = mod;
    return mod;
  },

  async turndown() {
    if (!window.TurndownService) await loadScript(convUrl(CONV_LIB.turndown));
    /* ATX headings ("## x") because the chunker keys off them, and fenced
       code so an indented block in a paper isn't mistaken for prose. */
    return new window.TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  },

  async mammoth() {
    if (!window.mammoth) await loadScript(convUrl(CONV_LIB.mammoth));
    return window.mammoth;
  },

  /* PDF text, page by page. Items arrive as positioned fragments with no
     notion of a line, so they are grouped by their y coordinate — without
     that, a two-column paper collapses into one run-on paragraph. */
  async pdfToMarkdown(file, onProgress) {
    const pdfjs = await this.pdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const out = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (onProgress) onProgress('page ' + n + '/' + doc.numPages);
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = new Map();
      for (const item of content.items) {
        if (!item.str) continue;
        const y = Math.round(item.transform[5]);
        if (!lines.has(y)) lines.set(y, []);
        lines.get(y).push(item.str);
      }
      const text = Array.from(lines.keys())
        .sort((a, b) => b - a)                       // PDF y grows upward
        .map(y => lines.get(y).join(' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
      if (text.trim()) out.push(text);
      page.cleanup();
    }
    await doc.destroy();
    return out.join('\n\n');
  },

  async docxToMarkdown(file) {
    const mammoth = await this.mammoth();
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const td = await this.turndown();
    return td.turndown(html || '');
  },

  /* Returns { name, markdown } — name always ends .md, since what goes into
     the corpus is Markdown regardless of what was handed in. */
  async toMarkdown(file, onProgress) {
    const ext = (file.name.match(UPLOAD_EXT) || [''])[0].toLowerCase();
    let md;
    if (ext === '.txt')       md = await file.text();
    else if (ext === '.pdf')  md = await this.pdfToMarkdown(file, onProgress);
    else if (ext === '.docx') md = await this.docxToMarkdown(file);
    else throw new Error('unsupported format');

    md = String(md || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!md) throw new Error('no text found — a scanned image PDF has no text layer to extract');
    const base = file.name.replace(/\.[^.]+$/, '');
    return { name: base + '.md', markdown: md };
  },
};
