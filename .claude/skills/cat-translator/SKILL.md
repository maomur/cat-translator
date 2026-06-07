---
name: cat-translator
description: Operate the cat-translator app to batch-translate Spanish product CSVs to Catalan via the OpenAI API. Use when asked to run/start the translator, translate one or many product CSV files ES→CA, troubleshoot translation runs (API errors, missing translations, HTML/cost issues), or verify/inspect translated output. Project lives at /Users/obb/Documents/Proyectos/cat-translator.
---

# cat-translator

Local Node.js + vanilla-JS web app that translates CSV product catalogs from
**Spanish → Catalan** using OpenAI `gpt-5-mini`, preserving HTML tags and all
non-translated columns. Full architecture and internals are in the project's
`CLAUDE.md` — read it before changing code.

Translates columns `name`, `description`, `x_short_description`. Keeps `id`,
`product_brand_id`, `supplier_product_code`, `default_code`, `barcode` intact.

## Start the app

```bash
cd /Users/obb/Documents/Proyectos/cat-translator
npm install            # first time only
node server.js         # → http://localhost:3000
```

Then the user drags a `.csv` onto the page and clicks **▶ Start Translation**.

Preflight checks before starting:
- `.env` exists and has a real `OPENAI_API_KEY=sk-...` (it's gitignored). If the
  startup banner prints "OPENAI_API_KEY is not set", the key is missing.
- After editing `server.js` or `.env`, **restart** the server (kill + relaunch);
  changes are not hot-reloaded.

To restart cleanly:

```bash
pkill -f "node server.js"; sleep 1; node server.js
```

## Translate a whole folder (batch / lote — preferred for many files)

The catalog is split into many CSVs (e.g.
`/Users/obb/Documents/Productos ES Separados a Traducir/CSV/parte_0XX.csv`). Use
the **"Carpeta (lote)"** tab in the UI:

1. Set the input folder path (prefilled) and the cost cap (default **$5**).
2. Click **▶ Traducir carpeta**. The server translates every `*.csv` and writes
   `<base>_CA.csv` into a `traducidos/` subfolder of the input folder.
3. Watch the overall progress (files X/N), current file, running tokens + cost,
   and the log. You can close the browser — the run continues server-side.

The batch is **resumable**: a manifest `traducidos/_batch-state.json` tracks
done files, so if it stops/crashes/cancels, re-running **skips** finished files
(zero token re-spend). It also **aborts immediately** on fatal API errors
(bad key / quota / model) and on hitting the **cost cap**, so a systemic problem
never burns tokens across all files.

Single-file mode (the "Un archivo" tab) still exists: drag → Start → **⬇
Download** for one-off files.

**Cost & reasoning effort.** `gpt-5-mini` is a reasoning model; `REASONING_EFFORT`
(default `minimal`) is the big lever. Real measured cost for ~96 files × 80 rows:
**~$5–6 with `minimal`**, ~$14 at full reasoning. **`minimal` is lossy** — in one
real run it truncated some long descriptions and left ~900 fields (4%) echoed in
Spanish. For quality, set `REASONING_EFFORT=low` (or `medium`) in `.env` and
restart; budget more. The three quality checks below catch most issues either way.

## Verify output (don't trust, check)

The engine runs three per-field checks and reports each as a warning
(`kind: html | length | untranslated`) — counted in the Final Report and printed
in the log. None reject the row; review the flagged ones.

1. **HTML warnings** — tags differ between source and translation.
2. **Length warnings** — translation < 60% of source length ⇒ possible truncation.
3. **Untranslated warnings** — the model echoed the Spanish back unchanged. This
   is the sneaky one: identical text passes the HTML/length checks, so without
   this detector it slips through silently. **Always check this count.**

Also confirm: row counts match, and non-translated columns (ids, codes, barcode)
are byte-for-byte identical to the source.

To deep-audit downloaded files (counts every issue across a folder):

```bash
node -e '
const s=require("/Users/obb/Documents/Proyectos/cat-translator/server.js");
const fs=require("fs"),path=require("path");
const SRC=process.argv[1],OUT=process.argv[2],TC=["name","description","x_short_description"];
const tg=x=>(x&&x.match(/<[^>]+>/g))||[];
let untr=0,html=0,short=0,err=0,colAlt=0,rowMis=0;
for(const n of fs.readdirSync(SRC).filter(f=>/\.csv$/i.test(f))){
  const op=path.join(OUT,n.replace(/\.csv$/i,"")+"_CA.csv"); if(!fs.existsSync(op))continue;
  const a=s.parseCSV(fs.readFileSync(path.join(SRC,n),"utf8")),b=s.parseCSV(fs.readFileSync(op,"utf8"));
  if(a.rows.length!==b.rows.length)rowMis++;
  for(let i=0;i<Math.min(a.rows.length,b.rows.length);i++){
    if(b.rows[i]._translation_error)err++;
    for(const h of a.headers)if(!TC.includes(h)&&h!=="_translation_error"&&(a.rows[i][h]||"")!==(b.rows[i][h]||""))colAlt++;
    for(const c of TC){const x=a.rows[i][c]||"",y=b.rows[i][c]||"";if(!x||!y)continue;
      if(s.looksUntranslated(x,y))untr++; if(tg(x).join("|")!==tg(y).join("|"))html++; if(x.length>=30&&y.length/x.length<0.6)short++;}}}
console.log({rowMis,colAlt,err,untranslated:untr,html,truncated:short});
' "<carpeta_origen>" "<carpeta_origen>/traducidos"
```

## Troubleshooting

- **`400 Unsupported value: 'temperature'`** — `gpt-5-mini` only allows the
  default temperature. Do not pass `temperature` to
  `openai.chat.completions.create`.
- **Every batch errors / 401** — bad or missing `OPENAI_API_KEY` in `.env`.
- **`429` / rate limits** — the engine already retries with backoff (1s/2s/4s);
  if persistent, lower `MAX_CONCURRENCY` in `server.js`.
- **Missing translations / "missing row in API response"** — the model returned
  malformed JSON or dropped a row index; usually transient, re-run the file.
- **Fields left in Spanish / truncated descriptions** — symptoms of
  `REASONING_EFFORT=minimal`. The `untranslated`/`length` warnings flag them.
  Fix by re-translating only the flagged rows (one field per call, higher
  reasoning, validate that tags match and the text actually changed), or re-run
  the whole batch with `REASONING_EFFORT=low`. Re-translating per field avoids
  the batch pressure that causes the model to echo/abbreviate.
- **Garbled accents in Excel** — output is UTF-8 with BOM already; ensure Excel
  imports as UTF-8.
- **Progress seems stuck** — open the **Live Log** (Section 3); each batch logs
  sent/received, tokens, running cost, retries, and HTML warnings.

## Editing the engine

When changing `server.js`, run the ad-hoc tests described in `CLAUDE.md`
(require the module, mock `srv.openai.chat.completions.create`, exercise
`runJob` / the HTTP server) before telling the user it works. Preserve the
**dedup-first** design and the no-`temperature` constraint.
