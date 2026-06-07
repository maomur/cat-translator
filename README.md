# CSV Translator · Spanish → Catalan

A local desktop web app that batch-translates CSV product catalogs from Spanish
to Catalan using the OpenAI API (`gpt-5-mini`). HTML tags inside fields are
preserved exactly; only visible text is translated.

Built with **Node.js + vanilla JS** — no Express, no build tools.

---

## Features

- Drag-and-drop CSV upload with live preview of the first 5 rows
- Translates only `name`, `description`, `x_short_description`; all other
  columns are kept byte-for-byte intact
- **HTML-safe**: `<br>`, `<b>`, `<p>`, `<strong>`, … are never altered; mismatches
  are flagged for human review (never silently rejected)
- Batches of 10 rows per API call, up to 3 concurrent calls
- String **deduplication cache** — identical source strings are translated once
- Strict JSON-in / JSON-out for reliable parsing
- Automatic retries with exponential backoff (1s, 2s, 4s)
- Real-time progress over **Server-Sent Events**: rows, batches, errors, token
  usage, and running cost in USD + EUR
- Cancel mid-run and still download partial results
- Output CSV is UTF-8 **with BOM** and fully quoted, for clean import into Excel

---

## Prerequisites

- **Node.js 18+**
- An OpenAI API key

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
node server.js
```

Then open <http://localhost:3000>.

## Usage

### One file (tab "Un archivo")

1. Drop (or click to select) a `.csv` file.
2. Review the detected columns and row count.
3. Click **▶ Start Translation**.
4. Watch progress, the live log, and the running cost.
5. When complete, click **⬇ Download Translated CSV**
   (saved as `<original_name>_CA.csv`).

### A whole folder (tab "Carpeta (lote)")

For translating many files at once:

1. Enter the input folder path and a cost cap (default **$5**).
2. Click **▶ Traducir carpeta**. Every `*.csv` is translated and written to a
   `traducidos/` subfolder as `<base>_CA.csv`.

The batch run is **server-side** (you can close the browser) and **resumable**:
a manifest `traducidos/_batch-state.json` tracks finished files, so re-running
skips them with no token re-spend. It **aborts immediately** on fatal API errors
(bad key / exhausted quota / wrong model) and on reaching the cost cap, so a
systemic failure never burns tokens across all files.

---

## Expected CSV format

Comma-separated, quoted fields, with this header:

```
"id","name","product_brand_id","supplier_product_code","default_code","barcode","description","x_short_description"
```

| Column                  | Action          |
| ----------------------- | --------------- |
| `name`                  | translated      |
| `description`           | translated      |
| `x_short_description`   | translated      |
| everything else         | kept unchanged  |

Empty / null fields are left empty in the output.

Rows that fail to translate after all retries keep their original Spanish
values and gain a `_translation_error` column describing the reason.

---

## Cost

`gpt-5-mini` pricing used for the live estimate:

- Input: **$0.25** per 1M tokens
- Output: **$2.00** per 1M tokens
- EUR shown at a fixed rate of **1 USD = 0.92 EUR**

Estimated cost for **39 files × 200 rows ≈ $0.05–0.15 USD total**. The
deduplication cache and OpenAI prompt caching (the system prompt is kept short
and stable) reduce this further when catalogs share repeated strings.

---

## Project structure

```
cat-translator/
├── server.js          HTTP server, routes, CSV parser, translation engine
├── public/
│   └── index.html     Single-file dashboard (vanilla JS)
├── package.json
├── .env.example
└── README.md
```

## API endpoints

| Method | Path                   | Purpose                                            |
| ------ | ---------------------- | -------------------------------------------------- |
| POST   | `/api/upload`          | Upload + parse CSV; returns `fileId`, preview      |
| POST   | `/api/translate`       | Start async job for a `fileId`; returns `jobId`    |
| GET    | `/api/events/:jobId`   | SSE stream: `progress`, `log`, `complete`, `error` |
| GET    | `/api/download/:jobId` | Download the translated CSV                         |
| POST   | `/api/cancel/:jobId`   | Cancel a job and keep partial results              |
