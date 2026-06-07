"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Busboy = require("busboy");
const OpenAI = require("openai");

// ---------------------------------------------------------------------------
// Minimal .env loader (no external dependency)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MODEL = "gpt-5-mini";
// gpt-5-mini is a reasoning model. For translation, deep reasoning adds little
// but explodes completion tokens (cost + latency). "minimal" keeps it fast and
// cheap. Override with REASONING_EFFORT=low|medium|high in .env if needed.
const REASONING_EFFORT = process.env.REASONING_EFFORT || "minimal";
const BATCH_SIZE = 10;
const MAX_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const TRANSLATE_COLUMNS = ["name", "description", "x_short_description"];

// Length safety net: a Catalan translation should be roughly as long as the
// Spanish source. If it comes back much shorter, the model may have truncated
// or summarized — flag it for human review (only for longer fields, to avoid
// noise on tiny strings like "Sí").
const LENGTH_CHECK_MIN_CHARS = 30;
const LENGTH_CHECK_MIN_RATIO = 0.6;

// Untranslated-field detector: the model occasionally echoes the Spanish source
// back unchanged instead of translating it. This passes the length/HTML checks
// (identical text → same length, same tags), so we detect it separately: a field
// whose translation is byte-identical to the source AND still contains clear
// Spanish markers (words/patterns that differ in Catalan) is almost certainly
// untranslated. Used only on echoed fields, so false positives just cost a flag.
const SPANISH_MARKERS =
  /\b(con|para|los|las|una|unos|unas|como|más|muy|este|esta|estos|estas|del|pero|también|según|niñ\w*|juego|juegos|años|incluye|hecho|fácil|blanco|negro|rojo|amarillo|ligero|saco|madera|agua|cocina|silla|cama|para el|con el|de la|en el|es un|es una|tu|sus|muñec\w*|pequeñ\w*|grande|nuevo|nueva)\b|ñ|ci[óo]n\b|dad\b/i;
const UNTRANSLATED_MIN_CHARS = 8;

function looksUntranslated(src, out) {
  if (src !== out) return false; // a real translation changed something
  const text = src.replace(/<[^>]+>/g, " ");
  return text.length >= UNTRANSLATED_MIN_CHARS && SPANISH_MARKERS.test(text);
}

// Pricing (USD per 1M tokens) and currency conversion
const PRICE_INPUT_PER_M = 0.25;
const PRICE_OUTPUT_PER_M = 2.0;
const USD_TO_EUR = 0.92;

const SYSTEM_PROMPT = `You are a professional Spanish-to-Catalan translator for e-commerce product catalogs.
Rules:
1. Translate only visible text. Never modify, remove, or reorder HTML tags.
2. Preserve all HTML tags exactly as they appear in the source.
3. Return ONLY a JSON object with key "rows" containing the translated array.
4. Keep the same array index "i" for each row.
5. If a field is empty string or null, return it unchanged.`;

// ---------------------------------------------------------------------------
// OpenAI client
// ---------------------------------------------------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "missing" });

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------
const files = new Map(); // fileId -> { name, headers, rows }
const jobs = new Map(); // jobId -> job object
const batches = new Map(); // batchId -> batch object

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, "" escapes, newlines inside quotes)
// ---------------------------------------------------------------------------
function parseCSV(text) {
  // Strip UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records = [];
  let field = "";
  let record = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // swallow, handle on \n (or treat lone \r as newline)
      if (text[i + 1] === "\n") {
        i++;
      }
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      i++;
      continue;
    }
    if (ch === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush trailing field/record if any content
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  if (records.length === 0) return { headers: [], rows: [] };

  const headers = records[0];
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    // Skip fully empty trailing lines
    if (rec.length === 1 && rec[0] === "") continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = rec[c] !== undefined ? rec[c] : "";
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  return '"' + str.replace(/"/g, '""') + '"';
}

function serializeCSV(headers, rows) {
  const lines = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  // UTF-8 BOM + CRLF line endings for Excel compatibility
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// HTML tag integrity helpers
// ---------------------------------------------------------------------------
function extractTags(str) {
  if (!str) return [];
  return str.match(/<[^>]+>/g) || [];
}

function tagsMatch(srcTags, dstTags) {
  if (srcTags.length !== dstTags.length) return false;
  for (let i = 0; i < srcTags.length; i++) {
    if (srcTags[i] !== dstTags[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SSE event emission
// ---------------------------------------------------------------------------
function emit(job, event) {
  job.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.clients) {
    try {
      res.write(payload);
    } catch (_) {
      /* client gone */
    }
  }
  // Optional hook: the batch orchestrator forwards per-file events to its own
  // SSE stream. Single-file jobs leave this undefined (no-op).
  if (typeof job.onEvent === "function") {
    try {
      job.onEvent(event);
    } catch (_) {
      /* ignore forwarding errors */
    }
  }
}

function log(job, level, message) {
  emit(job, {
    type: "log",
    level, // INFO | SUCCESS | WARNING | ERROR
    time: new Date().toISOString(),
    message,
  });
}

// ---------------------------------------------------------------------------
// Concurrency-limited task pool
// ---------------------------------------------------------------------------
async function runPool(items, concurrency, worker) {
  let index = 0;
  const runners = [];
  for (let k = 0; k < concurrency; k++) {
    runners.push(
      (async () => {
        while (true) {
          const myIndex = index++;
          if (myIndex >= items.length) return;
          await worker(items[myIndex], myIndex);
        }
      })()
    );
  }
  await Promise.all(runners);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Single batch API call with retry + exponential backoff
// ---------------------------------------------------------------------------
// Decide whether an error is worth retrying. Auth / quota / bad-request /
// not-found are systemic — retrying just burns time and (for some) tokens, so
// we surface them as fatal and let the caller abort. 429 + 5xx + network are
// transient and get the retry/backoff treatment.
function isFatalApiError(err) {
  const status = err && (err.status || err.statusCode);
  if (status === 401 || status === 403 || status === 404 || status === 400) {
    return true;
  }
  const code = err && (err.code || (err.error && err.error.code));
  const type = err && (err.type || (err.error && err.error.type));
  const fatalCodes = [
    "insufficient_quota",
    "invalid_api_key",
    "model_not_found",
    "invalid_request_error",
  ];
  if (fatalCodes.includes(code) || fatalCodes.includes(type)) return true;
  return false;
}

async function translateBatch(payloadRows, job) {
  const batchObj = { rows: payloadRows };
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      log(
        job,
        "WARNING",
        `Retry ${attempt}/${MAX_RETRIES} after error: ${lastErr} — waiting ${backoff}ms`
      );
      await sleep(backoff);
    }
    try {
      const response = await openai.chat.completions.create({
        model: MODEL,
        // Note: gpt-5-mini only supports the default temperature (1).
        reasoning_effort: REASONING_EFFORT,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(batchObj) },
        ],
      });
      const content = response.choices[0].message.content;
      const parsed = JSON.parse(content);
      if (!parsed || !Array.isArray(parsed.rows)) {
        throw new Error('response missing "rows" array');
      }
      const usage = response.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      return { rows: parsed.rows, usage };
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
      if (isFatalApiError(err)) {
        const fatal = new Error(lastErr);
        fatal.fatal = true;
        throw fatal; // do not retry — abort fast to avoid wasting tokens
      }
    }
  }
  throw new Error(lastErr || "unknown API error");
}

// ---------------------------------------------------------------------------
// Translation job engine
// ---------------------------------------------------------------------------
async function runJob(job) {
  const file = files.get(job.fileId);
  if (!file) {
    emit(job, { type: "error", message: "File not found" });
    job.status = "error";
    return;
  }

  const startTime = Date.now();
  const { headers, rows } = file;
  const total = rows.length;

  // Output rows start as a shallow copy of the originals
  const outRows = rows.map((r) => Object.assign({}, r));

  if (!process.env.OPENAI_API_KEY) {
    log(job, "ERROR", "OPENAI_API_KEY is not set. Aborting.");
    emit(job, { type: "error", message: "OPENAI_API_KEY is not set in .env" });
    job.status = "error";
    return;
  }

  // -------------------------------------------------------------------------
  // Deduplication pass: scan all rows, collect unique non-empty source strings
  // -------------------------------------------------------------------------
  const uniqueMap = new Map(); // source string -> unique index
  const uniques = []; // unique index -> source string
  let totalFieldValues = 0;
  for (const r of rows) {
    for (const col of TRANSLATE_COLUMNS) {
      const v = r[col];
      if (v == null || v === "") continue;
      totalFieldValues++;
      if (!uniqueMap.has(v)) {
        uniqueMap.set(v, uniques.length);
        uniques.push(v);
      }
    }
  }
  const uniqueCount = uniques.length;
  const callsSaved = totalFieldValues - uniqueCount; // reuse via dedup cache

  log(job, "INFO", `File loaded: ${file.name} (${total} rows)`);
  log(
    job,
    "INFO",
    `Cache built: ${uniqueCount} unique strings, ${callsSaved} duplicate field-translations reused`
  );

  // -------------------------------------------------------------------------
  // Batch unique strings: BATCH_SIZE rows x 3 field-slots = 30 strings per call
  // (keeps the documented row schema; field slot is just a label here)
  // -------------------------------------------------------------------------
  const STRINGS_PER_BATCH = BATCH_SIZE * TRANSLATE_COLUMNS.length;
  const batches = [];
  for (let s = 0; s < uniqueCount; s += STRINGS_PER_BATCH) {
    const slice = [];
    for (let k = s; k < Math.min(s + STRINGS_PER_BATCH, uniqueCount); k++) {
      slice.push(k); // unique index
    }
    batches.push(slice);
  }
  const totalBatches = batches.length;

  // Translation results, keyed by unique index
  const translated = new Array(uniqueCount).fill(null);
  const stringError = new Array(uniqueCount).fill(null); // reason or null

  // Shared progress / report state
  job.totalRows = total;
  job.totalBatches = totalBatches;
  job.processedRows = 0;
  job.processedBatches = 0;
  job.processedStrings = 0;
  job.errorRows = 0;
  job.promptTokens = 0;
  job.completionTokens = 0;
  job.errors = [];
  job.warnings = [];
  job.cacheHits = callsSaved;
  job.uniqueCount = uniqueCount;

  function currentCost() {
    const usd =
      (job.promptTokens / 1e6) * PRICE_INPUT_PER_M +
      (job.completionTokens / 1e6) * PRICE_OUTPUT_PER_M;
    return { usd, eur: usd * USD_TO_EUR };
  }

  function emitProgress() {
    const { usd, eur } = currentCost();
    // Derive a row counter from string progress (informational)
    const rowProgress =
      uniqueCount === 0
        ? total
        : Math.min(
            total,
            Math.round((job.processedStrings / uniqueCount) * total)
          );
    job.processedRows = rowProgress;
    emit(job, {
      type: "progress",
      processedRows: rowProgress,
      totalRows: total,
      processedBatches: job.processedBatches,
      totalBatches: job.totalBatches,
      errorRows: job.errorRows,
      promptTokens: job.promptTokens,
      completionTokens: job.completionTokens,
      cacheHits: job.cacheHits,
      costUsd: usd,
      costEur: eur,
    });
  }

  log(
    job,
    "INFO",
    `Starting translation: ${totalBatches} batches, up to ${MAX_CONCURRENCY} concurrent calls`
  );

  // -------------------------------------------------------------------------
  // Process one batch of unique strings
  // -------------------------------------------------------------------------
  async function processBatch(uidxs, batchNum) {
    if (job.cancelled) return;

    // Pack strings into the documented row schema, 3 slots per row.
    const payloadRows = [];
    const slotMap = []; // payload row index -> { name?:uidx, description?:uidx, x_short_description?:uidx }
    for (let p = 0; p < uidxs.length; p += TRANSLATE_COLUMNS.length) {
      const entry = { i: payloadRows.length };
      const map = {};
      for (let c = 0; c < TRANSLATE_COLUMNS.length; c++) {
        const uidx = uidxs[p + c];
        if (uidx === undefined) break;
        const col = TRANSLATE_COLUMNS[c];
        entry[col] = uniques[uidx];
        map[col] = uidx;
      }
      payloadRows.push(entry);
      slotMap.push(map);
    }

    log(
      job,
      "INFO",
      `Batch ${batchNum + 1}/${totalBatches}: sending ${uidxs.length} unique strings`
    );

    let result;
    try {
      result = await translateBatch(payloadRows, job);
    } catch (err) {
      for (const uidx of uidxs) stringError[uidx] = `API failure: ${err.message}`;
      job.processedBatches++;
      job.processedStrings += uidxs.length;
      if (err.fatal) {
        // Systemic error (auth/quota/bad-request): record it and stop the job
        // from scheduling further batches so we don't waste more tokens.
        job.fatalError = err.message;
        job.cancelled = true;
        log(
          job,
          "ERROR",
          `Batch ${batchNum + 1}/${totalBatches} fatal error (not retryable): ${err.message}`
        );
      } else {
        log(
          job,
          "ERROR",
          `Batch ${batchNum + 1}/${totalBatches} failed after ${MAX_RETRIES} retries: ${err.message}`
        );
      }
      emitProgress();
      return;
    }

    const batchIn = result.usage.prompt_tokens || 0;
    const batchOut = result.usage.completion_tokens || 0;
    job.promptTokens += batchIn;
    job.completionTokens += batchOut;

    const byIndex = new Map();
    for (const r of result.rows) {
      if (r && typeof r.i === "number") byIndex.set(r.i, r);
    }

    for (let pi = 0; pi < payloadRows.length; pi++) {
      const resRow = byIndex.get(pi);
      const map = slotMap[pi];
      for (const col of Object.keys(map)) {
        const uidx = map[col];
        const src = uniques[uidx];
        let out = resRow ? resRow[col] : undefined;
        if (out == null) {
          // Missing field in response: fall back to source, record error
          translated[uidx] = src;
          if (!resRow) stringError[uidx] = "missing row in API response";
          continue;
        }
        // HTML tag integrity check (against source string)
        const srcTags = extractTags(src);
        const dstTags = extractTags(out);
        if (!tagsMatch(srcTags, dstTags)) {
          const note =
            `Etiquetas HTML distintas (campo "${col}"): origen [${srcTags.join(
              " "
            )}] vs traducción [${dstTags.join(" ")}]`;
          job.warnings.push({ field: col, kind: "html", note, srcTags, dstTags, src });
          log(job, "WARNING", note);
        }
        // Length safety net: flag suspiciously short translations.
        if (src.length >= LENGTH_CHECK_MIN_CHARS) {
          const ratio = out.length / src.length;
          if (ratio < LENGTH_CHECK_MIN_RATIO) {
            const note =
              `Posible texto acortado (campo "${col}"): origen ${src.length} car. ` +
              `vs traducción ${out.length} car. (${Math.round(ratio * 100)}%) — revisar`;
            job.warnings.push({ field: col, kind: "length", note, src });
            log(job, "WARNING", note);
          }
        }
        // Untranslated detector: the model echoed the Spanish source unchanged.
        if (looksUntranslated(src, out)) {
          const note = `Campo sin traducir (campo "${col}"): el texto volvió en español sin cambios — revisar`;
          job.warnings.push({ field: col, kind: "untranslated", note, src });
          log(job, "WARNING", note);
        }
        translated[uidx] = out;
      }
    }

    job.processedBatches++;
    job.processedStrings += uidxs.length;
    const { usd, eur } = currentCost();
    const totalTok = job.promptTokens + job.completionTokens;
    log(
      job,
      "SUCCESS",
      `Batch ${batchNum + 1}/${totalBatches} done — +${batchIn} in / +${batchOut} out tokens · ` +
        `total ${totalTok} tokens (${job.promptTokens} in / ${job.completionTokens} out) · ` +
        `cost $${usd.toFixed(4)} (~€${eur.toFixed(4)})`
    );
    emitProgress();
  }

  emitProgress();
  await runPool(batches, MAX_CONCURRENCY, processBatch);

  const cancelled = job.cancelled;
  if (cancelled) {
    log(job, "WARNING", "Job cancelled — building partial results");
  }

  // -------------------------------------------------------------------------
  // Reconstruct output rows from translation results + dedup cache
  // -------------------------------------------------------------------------
  const seenErrorReasons = new Set();
  for (let idx = 0; idx < total; idx++) {
    let rowError = null;
    for (const col of TRANSLATE_COLUMNS) {
      const v = rows[idx][col];
      if (v == null || v === "") {
        outRows[idx][col] = ""; // reconstruct empty as empty
        continue;
      }
      const uidx = uniqueMap.get(v);
      if (uidx === undefined) continue;
      if (stringError[uidx]) {
        rowError = stringError[uidx];
        outRows[idx][col] = v; // keep original Spanish
      } else if (translated[uidx] != null) {
        outRows[idx][col] = translated[uidx];
      } else {
        // Never translated (e.g. cancelled before this string ran)
        rowError = "not translated (job cancelled)";
        outRows[idx][col] = v;
      }
    }
    if (rowError) {
      outRows[idx]._translation_error = rowError;
      job.errorRows++;
      const id = rows[idx].id != null ? rows[idx].id : `row#${idx}`;
      job.errors.push({ id, reason: rowError });
    }
  }

  const needsErrorColumn = job.errorRows > 0;
  const outHeaders = needsErrorColumn
    ? headers.concat(["_translation_error"])
    : headers.slice();
  if (needsErrorColumn) {
    for (const r of outRows) {
      if (r._translation_error == null) r._translation_error = "";
    }
  } else {
    for (const r of outRows) delete r._translation_error;
  }

  const csv = serializeCSV(outHeaders, outRows);
  job.outputCsv = csv;

  const base = file.name.replace(/\.csv$/i, "");
  job.downloadName = `${base}_CA.csv`;

  const elapsedMs = Date.now() - startTime;
  const { usd, eur } = currentCost();
  const successRows = total - job.errorRows;

  job.status = cancelled ? "cancelled" : "complete";
  job.processedRows = total;

  log(
    job,
    "SUCCESS",
    `${cancelled ? "Cancelled" : "Complete"}: ${successRows}/${total} rows translated`
  );

  emit(job, {
    type: "complete",
    cancelled,
    totalRows: total,
    successRows,
    errorRows: job.errorRows,
    errors: job.errors,
    warnings: job.warnings,
    warningCount: job.warnings.length,
    elapsedMs,
    promptTokens: job.promptTokens,
    completionTokens: job.completionTokens,
    totalTokens: job.promptTokens + job.completionTokens,
    cacheHits: job.cacheHits,
    uniqueCount: job.uniqueCount,
    costUsd: usd,
    costEur: eur,
    downloadName: job.downloadName,
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  // --- Static files ---
  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    return serveStatic(
      res,
      path.join(__dirname, "public", "index.html"),
      "text/html; charset=utf-8"
    );
  }

  // --- POST /api/upload ---
  if (method === "POST" && pathname === "/api/upload") {
    return handleUpload(req, res);
  }

  // --- POST /api/translate ---
  if (method === "POST" && pathname === "/api/translate") {
    return handleTranslate(req, res);
  }

  // --- GET /api/events/:jobId ---
  if (method === "GET" && pathname.startsWith("/api/events/")) {
    const jobId = decodeURIComponent(pathname.slice("/api/events/".length));
    return handleEvents(req, res, jobId);
  }

  // --- GET /api/download/:jobId ---
  if (method === "GET" && pathname.startsWith("/api/download/")) {
    const jobId = decodeURIComponent(pathname.slice("/api/download/".length));
    return handleDownload(req, res, jobId);
  }

  // --- POST /api/cancel/:jobId ---
  if (method === "POST" && pathname.startsWith("/api/cancel/")) {
    const jobId = decodeURIComponent(pathname.slice("/api/cancel/".length));
    return handleCancel(req, res, jobId);
  }

  // --- POST /api/batch/start ---
  if (method === "POST" && pathname === "/api/batch/start") {
    return handleBatchStart(req, res);
  }

  // --- GET /api/batch/events/:batchId ---
  if (method === "GET" && pathname.startsWith("/api/batch/events/")) {
    const batchId = decodeURIComponent(
      pathname.slice("/api/batch/events/".length)
    );
    return handleBatchEvents(req, res, batchId);
  }

  // --- POST /api/batch/cancel/:batchId ---
  if (method === "POST" && pathname.startsWith("/api/batch/cancel/")) {
    const batchId = decodeURIComponent(
      pathname.slice("/api/batch/cancel/".length)
    );
    return handleBatchCancel(req, res, batchId);
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleUpload(req, res) {
  let bb;
  try {
    bb = Busboy({ headers: req.headers });
  } catch (e) {
    return sendJSON(res, 400, { error: "Invalid multipart request" });
  }

  let fileBuffer = null;
  let fileName = "upload.csv";
  let rejected = false;

  bb.on("file", (name, stream, info) => {
    const { filename, mimeType } = info;
    if (filename) fileName = filename;
    const isCsv =
      /\.csv$/i.test(filename || "") ||
      mimeType === "text/csv" ||
      mimeType === "application/vnd.ms-excel";
    if (!isCsv) {
      rejected = true;
      stream.resume(); // drain
      return;
    }
    const chunks = [];
    stream.on("data", (d) => chunks.push(d));
    stream.on("end", () => {
      fileBuffer = Buffer.concat(chunks);
    });
  });

  bb.on("close", () => {
    if (rejected) {
      return sendJSON(res, 400, { error: "Only .csv files are accepted" });
    }
    if (!fileBuffer) {
      return sendJSON(res, 400, { error: "No CSV file received" });
    }
    let parsed;
    try {
      parsed = parseCSV(fileBuffer.toString("utf8"));
    } catch (e) {
      return sendJSON(res, 400, { error: "Failed to parse CSV: " + e.message });
    }
    if (parsed.headers.length === 0) {
      return sendJSON(res, 400, { error: "CSV appears to be empty" });
    }
    const fileId = crypto.randomUUID();
    files.set(fileId, {
      name: fileName,
      headers: parsed.headers,
      rows: parsed.rows,
    });
    return sendJSON(res, 200, {
      fileId,
      totalRows: parsed.rows.length,
      columns: parsed.headers,
      preview: parsed.rows.slice(0, 5),
    });
  });

  bb.on("error", (err) => {
    sendJSON(res, 400, { error: "Upload error: " + err.message });
  });

  req.pipe(bb);
}

function handleTranslate(req, res) {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (e) {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }
    const fileId = parsed.fileId;
    if (!fileId || !files.has(fileId)) {
      return sendJSON(res, 404, { error: "Unknown fileId" });
    }
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      fileId,
      status: "running",
      cancelled: false,
      clients: [],
      events: [],
      outputCsv: null,
      downloadName: null,
    };
    jobs.set(jobId, job);

    // Kick off async processing (do not await)
    runJob(job).catch((err) => {
      job.status = "error";
      emit(job, { type: "error", message: err.message });
    });

    return sendJSON(res, 200, { jobId });
  });
}

function handleEvents(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Unknown job");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");

  // Replay any events emitted before this client connected
  for (const event of job.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  job.clients.push(res);

  req.on("close", () => {
    const i = job.clients.indexOf(res);
    if (i !== -1) job.clients.splice(i, 1);
  });
}

function handleDownload(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.outputCsv) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("No output available for this job");
    return;
  }
  const body = Buffer.from(job.outputCsv, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${job.downloadName}"`,
    "Content-Length": body.length,
  });
  res.end(body);
}

function handleCancel(req, res, jobId) {
  const job = jobs.get(jobId);
  if (!job) {
    return sendJSON(res, 404, { error: "Unknown job" });
  }
  job.cancelled = true;
  return sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Batch (folder) engine — translate every CSV in a directory, resumable.
// ---------------------------------------------------------------------------
const OUTPUT_SUBDIR = "traducidos";
const MANIFEST_NAME = "_batch-state.json";

function emitBatch(batch, event) {
  batch.events.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of batch.clients) {
    try {
      res.write(payload);
    } catch (_) {
      /* client gone */
    }
  }
}

function batchLog(batch, level, message) {
  emitBatch(batch, {
    type: "log",
    level,
    time: new Date().toISOString(),
    message,
  });
}

function loadManifest(outputDir) {
  const p = path.join(outputDir, MANIFEST_NAME);
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return {}; // fresh start
  }
}

function saveManifest(outputDir, manifest) {
  try {
    fs.writeFileSync(
      path.join(outputDir, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2)
    );
  } catch (_) {
    /* best-effort */
  }
}

async function runBatch(batch) {
  const { inputDir, outputDir, files: fileNames, maxCostUsd } = batch;

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch (e) {
    emitBatch(batch, {
      type: "error",
      message: `Cannot create output folder: ${e.message}`,
    });
    batch.status = "error";
    return;
  }

  const manifest = loadManifest(outputDir);

  batch.cumUsd = 0;
  batch.cumIn = 0;
  batch.cumOut = 0;
  batch.results = [];
  let okCount = 0;
  let failCount = 0;
  let skipCount = 0;
  let warnFiles = 0;

  emitBatch(batch, {
    type: "batch-start",
    totalFiles: fileNames.length,
    inputDir,
    outputDir,
    maxCostUsd,
  });
  batchLog(
    batch,
    "INFO",
    `Batch started: ${fileNames.length} CSV files · cost cap $${maxCostUsd.toFixed(
      2
    )}`
  );

  function emitOverall(extra) {
    emitBatch(
      batch,
      Object.assign(
        {
          type: "progress",
          processedFiles: okCount + failCount + skipCount,
          totalFiles: fileNames.length,
          okCount,
          failCount,
          skipCount,
          cumIn: batch.cumIn,
          cumOut: batch.cumOut,
          costUsd: batch.cumUsd,
          costEur: batch.cumUsd * USD_TO_EUR,
        },
        extra || {}
      )
    );
  }

  for (let fi = 0; fi < fileNames.length; fi++) {
    if (batch.cancelled) {
      batchLog(batch, "WARNING", "Batch cancelled — stopping (resumable).");
      break;
    }

    const name = fileNames[fi];
    const base = name.replace(/\.csv$/i, "");
    const outName = `${base}_CA.csv`;
    const outPath = path.join(outputDir, outName);

    // Resume: skip files already done with their output present.
    const prev = manifest[name];
    if (prev && prev.status === "done" && fs.existsSync(outPath)) {
      skipCount++;
      batchLog(
        batch,
        "INFO",
        `[${fi + 1}/${fileNames.length}] ${name} — already done, skipped`
      );
      emitBatch(batch, {
        type: "file-done",
        fileIndex: fi,
        file: name,
        skipped: true,
      });
      emitOverall();
      continue;
    }

    // Cost cap (between files)
    if (batch.cumUsd >= maxCostUsd) {
      batch.status = "aborted-cost";
      batchLog(
        batch,
        "ERROR",
        `Cost cap $${maxCostUsd.toFixed(2)} reached — aborting batch (resumable).`
      );
      break;
    }

    emitBatch(batch, {
      type: "file-start",
      fileIndex: fi,
      file: name,
      totalFiles: fileNames.length,
    });
    batchLog(batch, "INFO", `[${fi + 1}/${fileNames.length}] ${name} — start`);

    // Parse the file
    let parsed;
    try {
      const raw = fs.readFileSync(path.join(inputDir, name), "utf8");
      parsed = parseCSV(raw);
    } catch (e) {
      failCount++;
      manifest[name] = { status: "failed", reason: `read/parse: ${e.message}` };
      saveManifest(outputDir, manifest);
      batch.results.push({ file: name, error: e.message });
      batchLog(batch, "ERROR", `${name} — read/parse failed: ${e.message}`);
      emitOverall();
      continue;
    }

    // Headless job that forwards events to the batch SSE stream
    const fileId = crypto.randomUUID();
    files.set(fileId, {
      name,
      headers: parsed.headers,
      rows: parsed.rows,
    });
    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      fileId,
      status: "running",
      cancelled: false,
      clients: [],
      events: [],
      outputCsv: null,
      downloadName: null,
      onEvent: (ev) => {
        if (ev.type === "log") {
          // Prefix file logs so the stream is readable
          emitBatch(batch, Object.assign({}, ev, { file: name }));
        } else if (ev.type === "progress") {
          // Mid-file cost guard: stop this file if it would exceed the cap.
          if (batch.cumUsd + (ev.costUsd || 0) > maxCostUsd) {
            job.cancelled = true;
          }
          emitOverall({
            file: name,
            fileIndex: fi,
            fileProcessedRows: ev.processedRows,
            fileTotalRows: ev.totalRows,
            fileCostUsd: ev.costUsd,
          });
        }
      },
    };
    jobs.set(jobId, job);

    try {
      await runJob(job);
    } catch (e) {
      // runJob normally handles its own errors; this is a safety net.
      job.fatalError = job.fatalError || e.message;
    }

    // Account this file's usage toward the running totals
    batch.cumIn += job.promptTokens || 0;
    batch.cumOut += job.completionTokens || 0;
    batch.cumUsd =
      (batch.cumIn / 1e6) * PRICE_INPUT_PER_M +
      (batch.cumOut / 1e6) * PRICE_OUTPUT_PER_M;

    // Fatal API error → abort the whole batch (don't burn tokens on 97 more)
    if (job.fatalError) {
      failCount++;
      manifest[name] = { status: "failed", reason: job.fatalError };
      saveManifest(outputDir, manifest);
      batch.results.push({ file: name, error: job.fatalError });
      files.delete(fileId);
      jobs.delete(jobId);
      batch.status = "aborted-fatal";
      batchLog(
        batch,
        "ERROR",
        `${name} — fatal API error, aborting batch: ${job.fatalError}`
      );
      emitBatch(batch, {
        type: "error",
        fatal: true,
        message: `Aborted on fatal API error: ${job.fatalError}. Fix the key/quota/model, then re-run to resume.`,
      });
      emitOverall();
      break;
    }

    // Write the translated CSV
    try {
      fs.writeFileSync(outPath, job.outputCsv, "utf8");
    } catch (e) {
      failCount++;
      manifest[name] = { status: "failed", reason: `write: ${e.message}` };
      saveManifest(outputDir, manifest);
      batch.results.push({ file: name, error: e.message });
      files.delete(fileId);
      jobs.delete(jobId);
      batchLog(batch, "ERROR", `${name} — write failed: ${e.message}`);
      emitOverall();
      continue;
    }

    const warnCount = (job.warnings && job.warnings.length) || 0;
    if (warnCount > 0) warnFiles++;
    okCount++;
    manifest[name] = {
      status: "done",
      output: outName,
      rows: job.totalRows,
      errorRows: job.errorRows,
      warnings: warnCount,
      promptTokens: job.promptTokens,
      completionTokens: job.completionTokens,
      finishedAt: new Date().toISOString(),
    };
    saveManifest(outputDir, manifest);
    batch.results.push({
      file: name,
      output: outName,
      rows: job.totalRows,
      errorRows: job.errorRows,
      warnings: warnCount,
    });

    batchLog(
      batch,
      job.errorRows > 0 ? "WARNING" : "SUCCESS",
      `[${fi + 1}/${fileNames.length}] ${name} → ${outName} · ` +
        `${job.totalRows - job.errorRows}/${job.totalRows} ok` +
        (job.errorRows ? `, ${job.errorRows} errores` : "") +
        (warnCount ? `, ${warnCount} avisos HTML` : "") +
        ` · total $${batch.cumUsd.toFixed(4)}`
    );

    emitBatch(batch, {
      type: "file-done",
      fileIndex: fi,
      file: name,
      output: outName,
      rows: job.totalRows,
      errorRows: job.errorRows,
      warnings: warnCount,
    });
    emitOverall();

    // Free memory before the next file
    files.delete(fileId);
    jobs.delete(jobId);
  }

  if (!batch.status || batch.status === "running") {
    batch.status = batch.cancelled ? "cancelled" : "complete";
  }

  const failed = batch.results.filter((r) => r.error);
  emitBatch(batch, {
    type: "batch-complete",
    status: batch.status,
    totalFiles: fileNames.length,
    okCount,
    failCount,
    skipCount,
    warnFiles,
    failed,
    cumIn: batch.cumIn,
    cumOut: batch.cumOut,
    totalTokens: batch.cumIn + batch.cumOut,
    costUsd: batch.cumUsd,
    costEur: batch.cumUsd * USD_TO_EUR,
    outputDir,
  });
  batchLog(
    batch,
    "SUCCESS",
    `Batch ${batch.status}: ${okCount} ok, ${failCount} con error, ${skipCount} omitidos · ` +
      `${batch.cumIn + batch.cumOut} tokens · $${batch.cumUsd.toFixed(
        4
      )} (~€${(batch.cumUsd * USD_TO_EUR).toFixed(4)})`
  );
}

function handleBatchStart(req, res) {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (e) {
      return sendJSON(res, 400, { error: "Invalid JSON body" });
    }
    const inputDir = parsed.inputDir;
    let maxCostUsd = parseFloat(parsed.maxCostUsd);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) maxCostUsd = 5;

    if (!inputDir || typeof inputDir !== "string") {
      return sendJSON(res, 400, { error: "Falta la carpeta de entrada" });
    }
    let stat;
    try {
      stat = fs.statSync(inputDir);
    } catch (e) {
      return sendJSON(res, 400, { error: `No existe la carpeta: ${inputDir}` });
    }
    if (!stat.isDirectory()) {
      return sendJSON(res, 400, { error: `No es una carpeta: ${inputDir}` });
    }
    if (!process.env.OPENAI_API_KEY) {
      return sendJSON(res, 400, { error: "OPENAI_API_KEY no está configurada en .env" });
    }

    let entries;
    try {
      entries = fs.readdirSync(inputDir);
    } catch (e) {
      return sendJSON(res, 400, { error: `No se puede leer la carpeta: ${e.message}` });
    }
    const csvFiles = entries
      .filter((n) => /\.csv$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (csvFiles.length === 0) {
      return sendJSON(res, 400, { error: "No hay archivos .csv en esa carpeta" });
    }

    const outputDir = path.join(inputDir, OUTPUT_SUBDIR);
    const manifest = loadManifest(outputDir);
    const skipped = csvFiles.filter((n) => {
      const prev = manifest[n];
      return (
        prev &&
        prev.status === "done" &&
        fs.existsSync(path.join(outputDir, `${n.replace(/\.csv$/i, "")}_CA.csv`))
      );
    });

    const batchId = crypto.randomUUID();
    const batch = {
      id: batchId,
      inputDir,
      outputDir,
      files: csvFiles,
      maxCostUsd,
      status: "running",
      cancelled: false,
      clients: [],
      events: [],
      cumUsd: 0,
      cumIn: 0,
      cumOut: 0,
      results: [],
    };
    batches.set(batchId, batch);

    runBatch(batch).catch((err) => {
      batch.status = "error";
      emitBatch(batch, { type: "error", message: err.message });
    });

    return sendJSON(res, 200, {
      batchId,
      total: csvFiles.length,
      pending: csvFiles.length - skipped.length,
      skipped: skipped.length,
    });
  });
}

function handleBatchEvents(req, res, batchId) {
  const batch = batches.get(batchId);
  if (!batch) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Unknown batch");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  for (const event of batch.events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  batch.clients.push(res);
  req.on("close", () => {
    const i = batch.clients.indexOf(res);
    if (i !== -1) batch.clients.splice(i, 1);
  });
}

function handleBatchCancel(req, res, batchId) {
  const batch = batches.get(batchId);
  if (!batch) {
    return sendJSON(res, 404, { error: "Unknown batch" });
  }
  batch.cancelled = true;
  return sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  CSV Translator (ES → CA) running`);
    console.log(`  → http://localhost:${PORT}`);
    if (!process.env.OPENAI_API_KEY) {
      console.log(
        `  ⚠  OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.\n`
      );
    } else {
      console.log("");
    }
  });
}

// Exported for testing
module.exports = {
  parseCSV,
  serializeCSV,
  csvEscape,
  extractTags,
  tagsMatch,
  looksUntranslated,
  runJob,
  runBatch,
  isFatalApiError,
  translateBatch,
  files,
  jobs,
  batches,
  openai,
  server,
};
