# Knowledge base

> **Everything in this folder is public.** The browser fetches these files
> directly to do retrieval, so anything you put here is readable by anyone who
> visits the site — and by anyone who guesses the filename, whether or not it
> is listed in `manifest.json`. Do not put anything private here: no unpublished
> drafts under embargo, no personal details you would not print on a business
> card, no third party's data. If you would not publish it on the homepage,
> it does not belong in `knowledge/`.

Everything the site's AI assistant is allowed to read lives in this folder.
The assistant answers **only** from these documents plus the site's own
command list. Ask it anything outside that scope and it declines.

## Adding a document

1. Drop the file in this folder. Supported: `.md`, `.txt`, `.json`, `.csv`.
2. Add one entry to `manifest.json`:

   ```json
   { "file": "03-my-doc.md", "title": "My document", "tags": "keywords here" }
   ```

3. Commit and push. GitHub Pages redeploys and the assistant picks it up on
   the next page load. No rebuild step, no embedding job.

The `tags` field is optional but helps retrieval — put words a visitor might
use that don't literally appear in the text.

## PDFs and Word documents

The retriever reads plain text, so convert first:

    # PDF  → text
    pdftotext -layout paper.pdf knowledge/04-paper.txt

    # DOCX → markdown
    pandoc cv.docx -t markdown -o knowledge/05-cv.md

Then add the entry to `manifest.json` as above.

## Session uploads

Visitors can also drag files onto the terminal (`/upload`). Those are read in
the browser for that session only — nothing is stored, and they vanish on
reload. Useful for "here's my CV, does it match your research?" without
putting anyone's file on the server.

## Size guidance

The retriever chunks documents and sends only the best-matching chunks to the
model, so total size is not a hard limit. But keep individual documents
focused — one topic per file retrieves far better than one giant file.
