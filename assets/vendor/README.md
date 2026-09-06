# Vendored libraries

Served from this origin rather than a CDN. Two reasons, in order of weight:

1. **Privacy.** `/upload` promises that a visitor's file never leaves their
   browser. Fetching the converter from a CDN did not send the file anywhere,
   but it did tell that CDN somebody on this site had just opened a PDF or a
   Word document. Now nothing outside colaco.se learns that an upload happened.
2. **Independence.** The upload feature keeps working if the CDN is blocked,
   throttled, or gone.

They are loaded lazily, on the first upload only, so a visitor who never
uploads never downloads them.

| File | Library | Version | Licence |
|---|---|---|---|
| `pdf.min.mjs`, `pdf.worker.min.mjs` | [pdf.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 |
| `mammoth.browser.min.js` | [mammoth.js](https://github.com/mwilliamson/mammoth.js) | 1.9.0 | BSD-2-Clause |
| `turndown.min.js` | [turndown](https://github.com/mixmark-io/turndown) | 7.2.0 | MIT |

To update, re-download from cdnjs at the pinned version and run
`node tools/regression.mjs`.
