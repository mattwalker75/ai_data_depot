# Generated documents

Ask in the chat and get a file: *"turn this into a memo for the Hendersons"*, *"make a spreadsheet
of every deadline in this file"*, *"write me a poem about flowers and save it as a PDF"*. The file
lands in `OUTPUT/`, a card appears under the reply, **Preview** opens it in a floating window
(both copies, downloads, Keep, Delete), and the **Files** tab in the right drawer lists them.

## How a request becomes a file

1. The chat system prompt tells the model that when the user asks for a file it must not write
   the document inline but return a small request block (`type`, `format`, `title`, `brief`).
   The reply you see is the model's one-line acknowledgement; the block is handled by the app.
2. If the model does not hand the request over (smaller local models sometimes don't) but the
   message plainly asks for a file, a **Make this a file?** button appears under the reply.
3. The 🗎 button beside the composer opens the same thing as a form (type, format, title, what it
   should contain), and **File** under any reply puts that reply into a PDF/Word/text file as-is.

## Types drive the model; formats only deliver

| Type | The model is told | Shape it returns | Formats |
| --- | --- | --- | --- |
| Memo / letter | audience, tone; To/Re · Summary · Discussion · Next steps | Markdown | PDF, Word, text |
| Summary / briefing | lead with the answer, bullets under headings, a Key facts table | Markdown | PDF, Word, text |
| Checklist | one table: Step · Owner · Due · Why, ordered by date | Markdown table | PDF, Word, Excel, text |
| Table / data extract | *extract, don't summarise*; one row per item; never invent | JSON sheets | Excel, PDF, Word, text |
| Comparison | criteria down the side, one column per thing compared | JSON sheets | Excel, PDF, Word, text |
| Free-form | exactly what the user described (poem, outline, letter…) | Markdown | PDF, Word, text |

A format the type does not allow falls back to the type's default (a memo asked for as Excel
becomes a PDF; the 🗎 form says so instead).

Prose types get one model call with the conversation so far as context and a fresh retrieval of
`output.context_chunks` passages (24) from the enabled bundles (or the focused document).
Tabular types run in **two passes**: the model first fixes the columns from the request, then the
app walks up to `output.max_documents` (12) relevant documents one at a time and asks for rows
from each, merging the results — so a table over many documents does not silently skip one, and
every row knows which document it came from.

## Two copies

When anything was cited, two files are written: the **client copy** (no `[n]` markers, no
general-knowledge labels) and the **cited copy** (markers kept, a Sources section; for Excel a
`Source` column and a Sources sheet). The preview window shows both under *Client copy* /
*With sources*, each with its own Download. A document that cites nothing — a poem, a general
explanation — is one file, and its card carries the *General knowledge* badge like a chat reply.

Chat modes apply exactly as in chat: in *Sources only* a request the sources cannot support is
refused with "Not in your sources"; in *Sources first* general-knowledge passages are labelled in
the cited copy and plain in the client copy.

## Files and retention

- Files live in `OUTPUT/` next to `config.json` (`output.dir`), named
  `<title>-<date>-<time>[-cited].<ext>`, gitignored.
- At startup, files of documents older than `output.keep_days` (30) are deleted **unless the
  document is marked Keep** in the Files tab. Only files recorded in the `outputs` table are ever
  touched — anything you put in `OUTPUT/` yourself is left alone. The document's card stays and
  says *expired*.
- Delete in the Files tab removes the files and the record.
- Generated files are not indexed unless you add `OUTPUT/` to a bundle yourself.
- Backups do not include generated files (they can be regenerated).

## Rendering

Pure npm, no system software: PDF via `pdfkit` (headings, paragraphs, bullet and numbered lists,
tables, page numbers), Word via `docx` (real headings, lists and tables), Excel via SheetJS
(typed cells: numbers and currency become numbers), text as Markdown. Word and Excel have no
in-browser preview, so the Files tab shows the app's HTML rendering of the same content for them.

Diagrams (Mermaid flowcharts in a document) are reserved in the document model as a block and
will be rendered in a later step.

## API

`GET /api/outputs?session=` · `POST /api/outputs/generate` `{ request, session_id, history,
bundle_ids, document_id, mode, persona }` · `POST /api/outputs/from-text` `{ title, markdown,
citations, format, session_id }` · `GET /api/outputs/:id` · `GET /api/outputs/:id/preview?variant=`
· `PATCH /api/outputs/:id { keep }` · `DELETE /api/outputs/:id` · `GET /output/:name[?download=1]`.
The chat `done` event carries `file_request` (from the model) or `file_hint` (from intent
detection).
