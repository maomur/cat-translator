# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A **local** desktop web app that batch-translates CSV product catalogs from
**Spanish → Catalan** using the OpenAI API (`gpt-5-mini`). Vanilla Node.js HTTP
server + a single-file vanilla-JS dashboard. **No Express, no frameworks, no
build step, no test runner.**

Run it, open the browser, drag a CSV, watch live progress, download the
translated `*_CA.csv`.

## Run

```bash
npm install
# .env must contain OPENAI_API_KEY=sk-...  (.env is gitignored; .env.example is the template)
npm run dev             # node --watch server.js → http://localhost:3000 (auto-reloads on server.js edits)
# or: npm start / node server.js  (no auto-reload)
```

The user always runs `npm run dev` — keep that script (`node --watch server.js`).
There is no `npm test`. Tests are ad-hoc Node scripts (see "Testing" below).

## Files

- `server.js` — everything backend: `.env` loader, HTTP router, CSV
  parser/serializer, the translation engine (`runJob`), SSE.
- `public/index.html` — the entire frontend (HTML + CSS + JS in one file).
- `.env` / `.env.example` — `OPENAI_API_KEY`, optional `PORT`.

## Architecture notes (the non-obvious parts)

- **Dedup-first engine, not row-first.** `runJob` scans *all* rows up front and
  collects the set of **unique non-empty strings** across the translatable
  columns (`name`, `description`, `x_short_description`). It translates each
  unique string exactly once, then maps results back onto rows. An earlier
  row-level lazy cache yielded **zero** cache hits under concurrency (all batch
  payloads are built before any response returns), which is why the engine
  deduplicates before batching. Don't regress this.
- **Batching.** Unique strings are packed into the documented JSON row schema,
  `BATCH_SIZE (10) × 3 field-slots = 30 strings per API call`, up to
  `MAX_CONCURRENCY (3)` concurrent calls via `runPool`. The field slot
  (name/description/...) is just a label — the system prompt treats all fields
  identically, so packing is field-agnostic.
- **`gpt-5-mini` constraint.** This model only supports the **default
  temperature (1)**. Do NOT add `temperature` to the
  `openai.chat.completions.create` call — it returns a 400. (Same for other
  sampling params that the model may reject.)
- **Reasoning effort.** `gpt-5-mini` is a reasoning model. `REASONING_EFFORT`
  (default `"minimal"`, override via `.env`) is passed to every call. `minimal`
  is ~3× cheaper/faster but **occasionally degrades quality** — it can truncate
  long descriptions or echo the Spanish source back untranslated. For
  quality-critical runs prefer `low`/`medium`. The three quality checks below
  exist precisely because `minimal` is lossy.
- **Three quality checks** (in `runJob`'s field loop — all flag `job.warnings`
  as `kind: "html" | "length" | "untranslated"`, never reject; the translation
  is still used):
  1. **HTML integrity** — tags extracted with `/<[^>]+>/g` and compared
     source-vs-translation; mismatch = warning.
  2. **Length safety net** — translation shorter than
     `LENGTH_CHECK_MIN_RATIO` (0.6) of the source (for fields ≥
     `LENGTH_CHECK_MIN_CHARS`) ⇒ possible truncation.
  3. **Untranslated detector** (`looksUntranslated`) — translation byte-identical
     to the source AND the source matches `SPANISH_MARKERS` ⇒ the model echoed
     Spanish. This is the only check that catches non-translation, because
     identical text passes the HTML and length checks. Added after a real run
     left ~900 fields (4%) untranslated under `minimal`.
- **Retries.** `translateBatch` retries up to `MAX_RETRIES (3)` with exponential
  backoff (1s/2s/4s). After that the batch's strings are marked errored; rows
  using them keep the **original Spanish** and gain a `_translation_error`
  column (added to the output only if at least one row errored).
- **SSE replay buffer.** Every job stores all emitted events in `job.events`.
  When a client connects to `/api/events/:jobId` it first **replays** the buffer,
  so no early `progress`/`log` events are lost in the gap between
  `POST /api/translate` and the `EventSource` connecting.
- **Cost.** Taken from the real `usage` field of each API response. Pricing:
  `$0.25/1M` input, `$2.00/1M` output; EUR at a fixed `0.92`. Per-batch and
  cumulative tokens + cost are emitted in both `progress` events and the log.
- **Output CSV.** UTF-8 **with BOM** (`﻿`), CRLF line endings, **all fields
  quoted**, filename `<original>_CA.csv`. Untranslated columns are copied
  byte-for-byte; empty fields stay empty.

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/upload` | multipart CSV → parse → `{fileId, totalRows, columns, preview}` |
| POST | `/api/translate` | `{fileId}` → starts async job → `{jobId}` |
| GET | `/api/events/:jobId` | SSE: `progress`, `log`, `complete`, `error` (with replay) |
| GET | `/api/download/:jobId` | the translated CSV |
| POST | `/api/cancel/:jobId` | cancel + keep partial results |
| POST | `/api/batch/start` | `{inputDir, maxCostUsd}` → translate every `*.csv` in a folder → `{batchId, total, pending, skipped}` |
| GET | `/api/batch/events/:batchId` | SSE: `batch-start`, `file-start`, `progress`, `log`, `file-done`, `batch-complete`, `error` (with replay) |
| POST | `/api/batch/cancel/:batchId` | cancel the batch (resumable) |

State (`files`, `jobs`, `batches`) lives in memory only — restarting the server
drops it. **Exception:** the batch manifest is persisted to disk (see below).

## Batch (folder) mode

`runBatch` translates every `*.csv` in a directory, reusing `runJob` per file
(one file at a time → flat memory; ≤3 concurrent calls per file). Output goes to
`<inputDir>/traducidos/<base>_CA.csv`. Driven from the web UI's "Carpeta (lote)"
tab; the run is **server-side**, so closing the browser doesn't stop it.

Anti-waste / robustness mechanisms (don't regress these — they're the whole
point of this mode):
- **Resume**: a manifest `<inputDir>/traducidos/_batch-state.json` records each
  file's status/tokens. On (re)start, files marked `done` with their `_CA.csv`
  present are **skipped** — zero token re-spend after a crash/stop.
- **Fatal-error fast-fail**: `isFatalApiError` flags non-retryable errors (401/
  403/404/400, `insufficient_quota`, `invalid_api_key`, `model_not_found`,
  `invalid_request_error`). `translateBatch` throws these immediately with
  `err.fatal=true` (no retry); `runJob` sets `job.fatalError` + `job.cancelled`;
  `runBatch` aborts the whole batch (status `aborted-fatal`) instead of burning
  tokens across the remaining files. Transient errors (429/5xx/network) still
  retry with backoff.
- **Hard cost cap** (`maxCostUsd`, UI default $5): checked between files and
  mid-file via the `emit` `onEvent` hook (sets `job.cancelled` if the next
  progress would exceed it → status `aborted-cost`).
- Per-file failures that aren't fatal are logged, marked `failed` in the
  manifest, and the batch **continues**.

The per-file `job` forwards its events to the batch SSE stream via the
`job.onEvent` hook added in `emit()`.

## Testing

`server.js` guards `server.listen` behind `require.main === module` and exports
internals (`parseCSV`, `serializeCSV`, `extractTags`, `tagsMatch`, `runJob`,
`files`, `jobs`, `openai`, `server`) so tests can `require()` it and **mock
`srv.openai.chat.completions.create`** without hitting the real API. Pattern:

```js
const srv = require("./server.js");
srv.openai.chat = { completions: { create: async ({messages}) => ({
  choices: [{ message: { content: JSON.stringify({ rows: [...] }) } }],
  usage: { prompt_tokens: 0, completion_tokens: 0 },
}) } };
```

Run engine tests against `srv.runJob(job)` and inspect `job.events` /
`job.outputCsv`; run HTTP e2e by `srv.server.listen(port)` and using the `http`
module.

## Conventions

- Match the existing style: plain CommonJS, no dependencies beyond `openai` and
  `busboy`, comments only where intent isn't obvious.
- Never commit `.env` or real API keys. `.env.example` must stay a placeholder.
- `npm run dev` (`node --watch`) auto-reloads on `server.js` edits. Edits to
  `public/index.html` just need a browser refresh; **`.env` changes need a
  restart** (the key is read once at startup). When not using `--watch`, restart
  manually after editing `server.js` or `.env`.
