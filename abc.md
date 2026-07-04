  # RBI Gap Assessment Tool — Technical Specification

**Version:** 1.0
**Status:** Working / validated end-to-end
**Last updated:** 2026-07-04

---

## Table of contents

1. [Purpose & scope](#1-purpose--scope)
2. [System overview](#2-system-overview)
3. [Technology stack (what, where, why)](#3-technology-stack-what-where-why)
4. [Repository layout](#4-repository-layout)
5. [Architecture](#5-architecture)
6. [End-to-end request lifecycle](#6-end-to-end-request-lifecycle)
7. [Backend components](#7-backend-components)
8. [The AI pipeline (extraction → evaluation)](#8-the-ai-pipeline-extraction--evaluation)
9. [Document ingestion & "OCR"](#9-document-ingestion--ocr)
10. [Assessment logic — the six metrics](#10-assessment-logic--the-six-metrics)
11. [Data models / schemas](#11-data-models--schemas)
12. [HTTP API reference](#12-http-api-reference)
13. [Frontend components](#13-frontend-components)
14. [Configuration & environment](#14-configuration--environment)
15. [Security](#15-security)
16. [Error handling & resilience](#16-error-handling--resilience)
17. [Performance & cost](#17-performance--cost)
18. [Limitations & assumptions](#18-limitations--assumptions)
19. [Extensibility / roadmap](#19-extensibility--roadmap)
20. [How to run](#20-how-to-run)

---

## 1. Purpose & scope

The Gap Assessment Tool is a local web application that assesses an
organization's **Policy / Procedure** document against a reference
**regulation** (e.g. an RBI Master Direction) and produces a structured
compliance gap report.

It implements the methodology defined in *"Logic for Gap Assessment Tool"*: it
extracts every regulatory obligation from the regulation, evaluates the policy
against each obligation clause-by-clause, and computes six metrics. The
guiding principle is **traceability** — every score can be traced back to
individual obligations, so the report is transparent, repeatable, and
defensible.

**Design philosophy:** the **AI does the reasoning** (reading documents,
extracting obligations, judging compliance); **Python does the arithmetic** (all
percentages, counts, and weighted scores are computed deterministically in code,
never by the model).

---

## 2. System overview

```
┌──────────────┐     upload/sample      ┌───────────────────────────┐
│   Browser    │ ─────────────────────▶ │   FastAPI backend (Python) │
│  (HTML/CSS/JS)│ ◀───── poll status ─── │                            │
└──────────────┘                        │  ┌──────────────────────┐  │
       ▲                                 │  │ extract → analyzer   │  │
       │ renders report                  │  │        → metrics     │  │
       │                                 │  └──────────┬───────────┘  │
       └─────────────────────────────────┘             │              │
                                                        ▼              │
                                              ┌──────────────────┐     │
                                              │  OpenAI Responses │◀────┘
                                              │  API (gpt-5.5)    │
                                              └──────────────────┘
```

- **Frontend:** a single-page app (no build step, no external CDN). Handles
  upload, kicks off the job, polls for progress, and renders the dashboard.
- **Backend:** FastAPI. Ingests documents, runs the two-stage AI pipeline,
  aggregates metrics deterministically, and serves the static frontend.
- **AI:** OpenAI's Responses API (default model `gpt-5.5`), used twice per
  assessment — once to extract obligations, once to evaluate the policy.

---

## 3. Technology stack (what, where, why)

| Layer | Technology | Version | Where it's used | Why |
|---|---|---|---|---|
| Language (backend) | **Python** | 3.13 | all of `backend/` | Rich ecosystem, first-class OpenAI SDK |
| Web framework | **FastAPI** | 0.115.6 | `main.py` (routing, DI, background tasks) | Async, typed, automatic validation, tiny |
| ASGI server | **Uvicorn** | 0.34.0 | launches `main:app` | Standard production ASGI server |
| File uploads | **python-multipart** | 0.0.20 | `main.py` `UploadFile`/`Form` | Required by FastAPI for `multipart/form-data` |
| LLM SDK | **openai** | ≥1.66 (2.44 installed) | `analyzer.py` | Official SDK; Responses API + vision + reasoning |
| Env loading | **python-dotenv** | ≥1.0 | `main.py` `load_dotenv()` | Reads `.env` so the key isn't hand-set each run |
| DOCX parsing | **stdlib** (`zipfile`, `re`, `html`) | — | `extract.py` | DOCX is a zip of XML; no third-party dep needed |
| PDF handling | **OpenAI vision** (no local lib) | — | `extract.py` + OpenAI | Model reads scanned PDFs; zero OCR dependency |
| Language (frontend) | **Vanilla HTML / CSS / JS** | ES2020 | `frontend/` | No framework/build; fully self-contained, offline |
| Charts | **Hand-drawn inline SVG** | — | `app.js` | No chart library / CDN; works offline |
| Concurrency | **stdlib `threading`** + FastAPI `BackgroundTasks` | — | `jobs.py`, `main.py` | Simple in-memory job store for progress polling |

**Not used (deliberately):** no database (jobs are in-memory), no message queue,
no frontend framework, no bundler, no CSS framework, no OCR engine, no
chart library. The whole thing is a static frontend + a small Python service.

---

## 4. Repository layout

```
gap-assessment-tool/
├─ backend/
│  ├─ main.py        FastAPI app: routes, .env loading, static serving, job orchestration
│  ├─ analyzer.py    Two-stage OpenAI Responses pipeline (extract → evaluate) + JSON parsing
│  ├─ prompts.py     The Logic document encoded as system prompts (EXTRACT_SYSTEM, EVALUATE_SYSTEM)
│  ├─ extract.py     DOCX/PDF/TXT → OpenAI content blocks (vision PDFs, dependency-free DOCX)
│  ├─ metrics.py     Deterministic six-metric aggregation
│  └─ jobs.py        In-memory job store (progress + result), thread-safe
├─ frontend/
│  ├─ index.html     Single page: setup → progress → results
│  ├─ styles.css     Design system (regtech aesthetic), responsive, no framework
│  └─ app.js         State, upload/sample handling, polling, SVG charts, tables, export
├─ sample_data/
│  ├─ RBI_MD_NDS_OM.pdf         reference regulation (scanned/image PDF)
│  ├─ Policy_A_compliant.docx   compliant test policy
│  └─ Policy_B_gaps.docx        intentionally deficient test policy
├─ .env               OPENAI_API_KEY (+ optional OPENAI_MODEL) — git-ignored
├─ .env.example       placeholder template
├─ .gitignore         excludes .env, .venv, __pycache__
├─ requirements.txt   pinned Python deps
├─ run.ps1            PowerShell launcher
├─ run.sh             bash launcher
├─ Start Gap Tool.bat double-click Windows launcher
├─ README.md          user-facing quick start
└─ TECHNICAL_SPEC.md  this document
```

---

## 5. Architecture

### 5.1 Layers

1. **Presentation** (`frontend/`) — stateless SPA. Talks to the backend over
   JSON + `multipart/form-data`. Renders three views (setup / progress /
   results) driven by client-side state.
2. **API / orchestration** (`main.py`) — thin HTTP layer. Validates inputs,
   resolves the two source documents, creates a job, and dispatches the pipeline
   to a background task. Also serves the static frontend from the same origin
   (so there is no CORS).
3. **Ingestion** (`extract.py`) — converts each uploaded file into an OpenAI
   Responses "content block".
4. **Reasoning** (`analyzer.py` + `prompts.py`) — the two-stage LLM pipeline.
5. **Aggregation** (`metrics.py`) — pure functions; deterministic math.
6. **State** (`jobs.py`) — in-memory, thread-safe job registry for progress.

### 5.2 Key architectural decisions

- **Single origin.** The backend serves the frontend as static files
  (`StaticFiles(html=True)` mounted at `/`), registered *after* the `/api/*`
  routes so API routes win. No separate frontend server, no CORS config.
- **Async job + polling.** Analysis takes tens of seconds to minutes, so
  `POST /api/analyze` returns immediately with a `job_id`; the work runs in a
  FastAPI `BackgroundTasks` thread; the browser polls `GET /api/jobs/{id}` every
  1.5 s. This keeps the HTTP request short and gives a live progress stepper.
- **Deterministic aggregation.** The model returns per-obligation judgments;
  Python computes every number. This guarantees the report is reproducible and
  auditable regardless of model variance.
- **Provider-swappable core.** Prompts and metrics are provider-agnostic. Only
  `analyzer.py` (the SDK call) and `extract.py` (content-block shapes) are
  OpenAI-specific — the project was migrated from Anthropic to OpenAI by
  changing only those two files plus config.

---

## 6. End-to-end request lifecycle

```
User picks Regulation + Policy (upload or sample) + depth, clicks Run
        │
        ▼
[Browser]  POST /api/analyze   (multipart: files and/or sample ids, effort)
        │
        ▼
[main.py]  _resolve_source() ×2  ── extract.prepare_source() ── content blocks
        │  jobs.create() → job_id
        │  BackgroundTasks.add_task(_run_job, ...)
        │  return {job_id, ...}  (immediately)
        │
        ├───────────────► [Browser] starts polling GET /api/jobs/{job_id} @1.5s
        │
        ▼  (background thread)
[analyzer.analyze()]
   Stage 1  _run(EXTRACT_SYSTEM,  [regulation_block, instruction])  → obligations JSON
            progress: "extracting" → "extracted (N obligations)"
   Stage 2  _run(EVALUATE_SYSTEM, [policy_block, obligations, instruction]) → assessments JSON
            progress: "evaluating"
   metrics.compute(obligations, assessments)   progress: "computing" → "done"
        │
        ▼
[jobs] status=done, result={summary, metric1..6, register, meta}
        │
        ▼
[Browser] poll sees status=done → renderResults() → dashboard
```

Each `_run` call is one OpenAI Responses API request. So a full assessment is
**two** LLM calls plus pure-Python aggregation.

---

## 7. Backend components

### 7.1 `main.py` — API & orchestration
- Loads `.env` via `load_dotenv(BASE_DIR/".env")` **before** importing
  `analyzer` (because `analyzer` reads `OPENAI_MODEL` at import time).
- Declares the sample registry (`SAMPLES` dict: RBI MD, Policy A, Policy B).
- Routes:
  - `GET /api/health` — `{status, model, credentials}`. `credentials` is
    `bool(OPENAI_API_KEY)`.
  - `GET /api/samples` — bundled documents + availability.
  - `POST /api/analyze` — resolves both sources, creates a job, dispatches the
    background task, returns the `job_id`.
  - `GET /api/jobs/{job_id}` — returns the job record (status/stage/message/
    result/error).
- `_resolve_source()` — turns an upload **or** a sample id into a
  `prepare_source()` descriptor; uploads are written to a per-request temp dir.
- `_run_job()` — calls `analyzer.analyze(...)`, wiring the `progress` callback to
  `jobs.set_progress`; maps `openai.AuthenticationError` / `openai.NotFoundError`
  to friendly messages.
- Mounts the static frontend last so `/api/*` takes precedence.

### 7.2 `extract.py` — ingestion
See §9. Public function `prepare_source(path, label)` returns a descriptor:
`{label, filename, kind, block, char_count, preview}` where `block` is an OpenAI
content block. `SUPPORTED_EXTS = {.pdf, .docx, .txt, .md}`; anything else raises
`ExtractionError`.

### 7.3 `prompts.py` — encoded methodology
Holds the two system prompts (`EXTRACT_SYSTEM`, `EVALUATE_SYSTEM`) and two helper
functions that build the user-turn instructions (`extract_user_text()`,
`evaluate_user_text(obligations_json)`). This file is the "AI configuration"
described in the Logic document — see §8 and §10.

### 7.4 `analyzer.py` — the pipeline
- `MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.5")`
- `REQUEST_TIMEOUT = 1500` s, `MAX_OUTPUT_TOKENS = 48000`.
- `_client()` → `openai.OpenAI(timeout=…)`.
- `_is_reasoning_model(name)` → true for `o1/o3/o4/o5/gpt-5*` prefixes.
- `_run(client, system, content_blocks, effort)` — one Responses call with a
  graceful-degradation attempt ladder (see §8.3).
- `_parse_json(text, key)` — tolerant JSON extraction (strips code fences, falls
  back to the outermost `{…}` span, accepts either `{key:[…]}` or a bare list).
- `analyze(regulation, policy, effort, progress)` — orchestrates the two stages
  and calls `metrics.compute`.

### 7.5 `metrics.py` — aggregation
Pure functions. `compute(obligations, assessments)` joins the two lists by
`obligation_id` (`_merge`), then derives all six metrics and the overall score.
See §10 for formulas. No I/O, no model calls — fully deterministic and unit-testable.

### 7.6 `jobs.py` — state
Thread-safe in-memory dict guarded by a `threading.Lock`. Job record:
`{id, status, stage, message, created_at, result, error}`. `status ∈ {queued,
running, done, error}`. `cleanup(max_age=3600)` drops jobs older than an hour.
**Note:** in-memory means jobs are lost on server restart and are not shared
across multiple worker processes (run single-process, which is the default).

---

## 8. The AI pipeline (extraction → evaluation)

### 8.1 Stage 1 — Obligation extraction
- **System prompt:** `EXTRACT_SYSTEM`. Instructs the model to read the
  regulation *first*, ignore headings/definitions/examples unless enforceable,
  and emit **one object per obligation**.
- **Input:** `[<regulation content block>, {"type":"input_text", text: extract_user_text()}]`.
- **Output:** `{"obligations": [ {obligation_id, source, section, paragraph,
  regulatory_text, mandatory, keywords[], subject, action_required,
  applicability_note}, … ]}`.
- Obligation ids are normalized to `OB-001, OB-002, …` if the model omits them.

### 8.2 Stage 2 — Policy evaluation
- **System prompt:** `EVALUATE_SYSTEM`. Encodes the cross-cutting rules
  (semantic matching not keyword matching, search the whole policy, generic
  statements earn no credit, stricter-control rule, contradictions downgrade,
  applicability only from the regulation, procedure/evidence gaps do not reduce
  compliance) and the per-obligation output contract for every metric.
- **Input:** `[<policy content block>, {"type":"input_text", text:
  evaluate_user_text(obligations_json)}]` — the full obligation register from
  Stage 1 is passed back in as text.
- **Output:** `{"assessments": [ {obligation_id, coverage_status,
  compliance_status, missing_elements[], score, policy_references[],
  procedure_references[], annexure_references[], supporting_documents[],
  traceability_status, gap|null, maturity:{L1,L2,L3}, confidence, reasoning},
  … ]}` — one per obligation.

### 8.3 Model call & graceful degradation
`_run` builds a base request (`model`, `instructions`=system prompt,
`input`=content blocks, `max_output_tokens`) and tries progressively simpler
configurations, catching `openai.BadRequestError` between attempts:

1. **reasoning effort + JSON mode** — `reasoning={"effort": effort}` +
   `text={"format":{"type":"json_object"}}` (only attempted for reasoning
   models).
2. **JSON mode only** — for non-reasoning models (e.g. gpt-4o/4.1) that reject
   the `reasoning` param.
3. **plain** — last resort for models without JSON mode.

This makes the tool work with **any** OpenAI model the user configures, while
using the richest features available. The response text is read from
`response.output_text`; an `incomplete` status (e.g. hit the output cap) raises a
clear `AnalyzerError`.

### 8.4 Depth ↔ reasoning-effort mapping
The UI's Fast / Balanced / Thorough control sends `low` / `medium` / `high`,
passed straight through as `reasoning.effort` for reasoning models. For
non-reasoning models it's ignored (dropped at attempt 2).

---

## 9. Document ingestion & "OCR"

`extract.prepare_source()` produces an OpenAI content block per file:

| Input | Block emitted | How text is obtained |
|---|---|---|
| `.pdf` | `{"type":"input_file","filename":…,"file_data":"data:application/pdf;base64,…"}` | **OpenAI vision** — the raw PDF is base64-encoded and sent whole; OpenAI extracts any text layer *and* renders each page to an image the model reads |
| `.docx` | `{"type":"input_text","text": "### <label>: <name>\n\n<text>"}` | `_docx_to_text()` — unzips `word/document.xml` and converts it with regex |
| `.txt` / `.md` | `{"type":"input_text","text": …}` | read directly |

### 9.1 DOCX extraction (`_docx_to_text`)
A DOCX is a ZIP containing OOXML. The extractor:
1. Reads `word/document.xml`.
2. Converts structure to plain text: `<w:tab/>`→tab, `<w:br/>`→newline,
   `</w:tc>`→cell separator `\t|\t`, `</w:tr>`→newline, `</w:p>`→newline.
3. Removes `</w:t>`, strips **only** `<w:t …>` opening tags (a word-boundary
   regex so `<w:tbl>/<w:tr>/<w:tc>` aren't matched), then strips all remaining
   tags and unescapes XML entities.
4. Collapses excess blank lines.

This is deliberately dependency-free (no `python-docx`). It also preserves table
cell/row structure, which matters for the policies' RACI/checklist tables.

### 9.2 "OCR" — there isn't a classic one
There is **no** OCR engine (no Tesseract/poppler) in the runtime path. For
scanned/image PDFs like the RBI Master Direction (a "Print to PDF" with a JPEG
per page and no text layer), OpenAI renders the pages to images and the
**vision model reads the text directly**. This is why the tool has zero
PDF/OCR dependencies but still handles image-only regulations. Requirement: a
vision-capable model (gpt-5.5 / gpt-4o / gpt-4.1 all qualify).

---

## 10. Assessment logic — the six metrics

All metrics are computed in `metrics.compute()`. `applicable` = obligations
whose `compliance_status` (or `coverage_status`) is **not** "Not Applicable";
the denominator `n_app` guards against divide-by-zero.

> **Note:** the source Logic document numbers metrics 1, 2, 3, 4, **6** (there is
> no Metric 5), plus the Overall Policy Matching Score. This tool preserves that
> numbering.

### Metric 1 — Regulatory Obligation Coverage (%)
*Has each obligation been addressed at all?* Per-obligation `coverage_status ∈
{Covered, Partial, Not Covered, Not Applicable}`.

```
coverage_pct = 100 × (Covered + 0.5 × Partial) / Applicable
```
Partial counts as half; Not Covered = 0; Not Applicable excluded from the
denominator.

### Metric 2 — Compliance Status Distribution
*To what extent is each obligation satisfied?* Counts of `compliance_status ∈
{Fully Compliant, Partially Compliant, Non-Compliant, Not Applicable}`.
Rendered as the donut chart.

### Metric 3 — Gap Count & Gap Severity
Only Partial / Non-Compliant obligations produce a gap (Fully Compliant and Not
Applicable produce none). **One obligation → at most one gap record.** Each gap
has a `category` (Missing / Partial / Incorrect / Ambiguous / Outdated /
Inconsistent Requirement) and a `severity` driven by **regulatory impact**:

| Severity | Meaning |
|---|---|
| **Critical** | Direct breach of a mandatory requirement, likely supervisory action (e.g. no SGL account, no CCIL membership, market-abuse controls absent) |
| **High** | Major weakness; compliance possible but significantly weakened |
| **Medium** | Important improvement, limited immediate regulatory impact |
| **Low** | Documentation / formatting / wording only |

Python assigns `gap_id`s, sorts Critical→Low, and tallies `severity_counts` and
`category_counts`.

### Metric 4 — Clause Traceability Matrix
Every obligation maps to its supporting evidence:
`policy_references[], procedure_references[], annexure_references[],
supporting_documents[]`, with `traceability_status ∈ {Fully, Partially, Not
Traceable}`. Where no evidence exists, references are empty and the UI shows
"Not Found". Produces both a status tally (donut) and a full matrix table.

### Metric 6 — L1 / L2 / L3 Implementation Maturity
Three independent dimensions scored 0–100 per obligation, averaged over
applicable obligations:

| Level | Client-facing name | Measures |
|---|---|---|
| **L1** | Governance Maturity | policy exists, ownership, accountability, board approval, review cycle |
| **L2** | Process Maturity | SOPs, workflow, controls, maker-checker, frequency, RACI, exceptions |
| **L3** | Operational Maturity | evidence: logs, reports, approvals, audit trails, management review, KPIs |

```
overall_maturity = 0.30 × L1 + 0.35 × L2 + 0.35 × L3
```
Guardrails (enforced in the prompt): a higher level cannot compensate for a
missing lower level; compliance status must not drive maturity; evidence must
not raise L1/L2; governance docs must not raise L3. Bands: ≥75 Mature, ≥40
Developing, >0 Initial, else Absent.

### Overall Policy Matching Score
Numeric value per obligation: Fully = 1.0, Partial = 0.5, Non = 0.0, NA =
excluded (the model returns `score`; Python re-derives it from
`compliance_status` if missing).

```
overall_matching_score = 100 × Σ(score) / Applicable obligations
```
This is the headline gauge. It measures **policy compliance only** — not maturity
or evidence, which are separate metrics.

---

## 11. Data models / schemas

### 11.1 Obligation (Stage 1 output element)
```json
{
  "obligation_id": "OB-004",
  "source": "RBI Master Direction - NDS-OM",
  "section": "II",
  "paragraph": "5(a)",
  "regulatory_text": "…",
  "mandatory": "Mandatory|Recommended|Conditional",
  "keywords": ["shall", "SGL"],
  "subject": "the entity",
  "action_required": "Maintain an SGL account with the Reserve Bank",
  "applicability_note": "Applies to entities seeking direct access"
}
```

### 11.2 Assessment (Stage 2 output element)
```json
{
  "obligation_id": "OB-004",
  "coverage_status": "Covered|Partial|Not Covered|Not Applicable",
  "compliance_status": "Fully Compliant|Partially Compliant|Non-Compliant|Not Applicable",
  "missing_elements": ["SGL account requirement"],
  "score": 1.0,
  "policy_references": ["Section 9"],
  "procedure_references": [],
  "annexure_references": [],
  "supporting_documents": [],
  "traceability_status": "Fully Traceable|Partially Traceable|Not Traceable",
  "gap": null,
  "maturity": { "L1": 80, "L2": 40, "L3": 0 },
  "confidence": 0.95,
  "reasoning": "…"
}
```
`gap` is `null` for Fully Compliant / Not Applicable; otherwise:
```json
{ "category": "Missing Requirement", "severity": "Critical",
  "description": "…", "business_impact": "…", "recommendation": "…" }
```

### 11.3 Result (returned to the frontend)
```json
{
  "summary": { "total_obligations", "applicable_obligations", "not_applicable",
               "overall_matching_score", "coverage_pct", "total_gaps",
               "critical_gaps", "overall_maturity" },
  "metric1_coverage":    { "coverage_pct", "counts", "formula" },
  "metric2_distribution":{ "counts" },
  "metric3_gaps":        { "total", "severity_counts", "category_counts", "gaps": [ … ] },
  "metric4_traceability":{ "counts", "matrix": [ … ] },
  "metric6_maturity":    { "L1","L2","L3","L1_band","L2_band","L3_band",
                           "overall","weights","labels" },
  "overall_score":       { "matching_score","score_sum","denominator","formula" },
  "register": [ <obligation merged with its assessment>, … ],
  "meta": { "regulation":{…}, "policy":{…}, "model", "effort" }
}
```
A gap record inside `metric3_gaps.gaps`:
```json
{ "gap_id":"GAP-001", "obligation_id":"OB-004", "regulation_reference":"5(a)",
  "policy_reference":"Not Found", "severity":"Critical", "category":"Missing Requirement",
  "description":"…", "business_impact":"…", "recommendation":"…", "confidence":0.98 }
```

---

## 12. HTTP API reference

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/health` | — | `{status, model, credentials}` |
| `GET` | `/api/samples` | — | `{samples:[{id,label,role,file,note,available}]}` |
| `POST` | `/api/analyze` | `multipart/form-data`: `regulation_file?`, `policy_file?`, `regulation_sample?`, `policy_sample?`, `effort` | `{job_id, regulation, policy, effort}` |
| `GET` | `/api/jobs/{job_id}` | — | job record (see §7.6) |
| `GET` | `/` (and static assets) | — | the SPA |

`effort ∈ {low, medium, high}` (invalid values coerced to `medium`). Each slot
takes **either** an uploaded file **or** a sample id; a missing slot → `400`.

---

## 13. Frontend components

Single page (`index.html`) with three views toggled by `showView()`:
**setup → progress → results**. All logic in `app.js` (no framework); all
styling in `styles.css` (custom design system, CSS variables, responsive grid).

- **State** (`state` object): selected regulation/policy (file or sample), depth,
  `jobId`, poll handle, and the final `result`.
- **Input handling:** two drop-zones with drag-and-drop + click-to-browse
  (`wireDropzone`), plus sample chips. Selecting a sample clears the uploaded
  file for that slot and vice-versa (mutually exclusive).
- **Run + poll:** `run()` builds `FormData`, POSTs `/api/analyze`, then
  `setInterval(pollJob, 1500)` polls `/api/jobs/{id}`. `setStage()` drives the
  4-step progress stepper.
- **Charts (inline SVG, hand-drawn):**
  - `gauge()` — semicircular arc for the overall score.
  - `donut()` — compliance distribution & traceability.
  - `renderSeverity()` — horizontal bar chart for gap severity.
  - `renderMaturity()` — L1/L2/L3 progress bars with weights + overall.
- **Tables:** Obligation Register (filter by compliance status + free-text
  search, rows expand to reasoning + JSON), Gap Register (filter by severity),
  Traceability Matrix. Tabs switch between them.
- **Export:** `exportJson()` (full result) and `exportCsv()` (flattened register).
- **Credential banner:** on load, `GET /api/health`; if `credentials=false`, a
  banner tells the user to set `OPENAI_API_KEY`.

No external resources are fetched — the SVG favicon is inline and there is no CDN,
so the UI works offline once the server is up.

---

## 14. Configuration & environment

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — (required) | OpenAI credential; read from `.env` or the shell |
| `OPENAI_MODEL` | `gpt-5.5` | Any vision-capable model (`gpt-5.5`, `gpt-5`, `gpt-4.1`, `gpt-4o`, `o4-mini`, …) |

`.env` is loaded by `main.py` at startup and is **git-ignored**. `.env.example`
is the shareable placeholder. Reasoning models honour the depth control;
non-reasoning models ignore it gracefully.

Tunables in code: `analyzer.MAX_OUTPUT_TOKENS` (48000), `analyzer.REQUEST_TIMEOUT`
(1500 s), `jobs.cleanup` max age (3600 s), frontend poll interval (1500 ms).

---

## 15. Security

- **Key handling:** the API key lives server-side only (in `.env` /
  environment). It is never sent to the browser; `/api/health` returns only a
  boolean `credentials` flag. `.gitignore` excludes `.env`.
- **Uploads:** written to a per-request temp directory; only whitelisted
  extensions are accepted; content is sent to OpenAI for analysis (note: your
  documents leave your machine — see §18).
- **No auth on the local server.** It binds to `127.0.0.1` (localhost) and is
  intended for single-user local use. Do **not** expose it on `0.0.0.0` / a
  public interface without adding authentication.
- **No persistence.** Documents and results are not stored to disk (jobs are
  in-memory and expire); exports are user-initiated.

---

## 16. Error handling & resilience

- **Ingestion:** `ExtractionError` → `400` with a clear message (unsupported
  type, unreadable file, empty text).
- **Model params:** `_run` degrades across three attempts (§8.3) so unsupported
  params don't hard-fail.
- **Auth / model errors:** `openai.AuthenticationError` and
  `openai.NotFoundError` are mapped to actionable messages surfaced in the UI
  banner (set `OPENAI_API_KEY` / set `OPENAI_MODEL`).
- **Malformed JSON:** `_parse_json` strips fences and extracts the outermost
  object; JSON mode (attempt 1–2) makes valid JSON the norm.
- **Truncation:** if the response is `incomplete` (hit `max_output_tokens`), a
  clear error suggests lowering depth or raising the limit.
- **Missing/short assessments:** `metrics._merge` joins by id and falls back to
  positional matching, defaulting absent fields rather than crashing.
- **Polling:** transient poll failures are ignored; the interval keeps retrying.

---

## 17. Performance & cost

- **Two LLM calls per assessment** (extract + evaluate) + negligible Python.
- **Observed:** RBI MD (7-page scan) + Policy B at `low` effort → **~76 s**, 21
  obligations. Higher depth (`high`) is slower and more thorough.
- **Cost drivers:** scanned-PDF vision tokens (each page becomes image tokens),
  the obligation register echoed into Stage 2, and reasoning tokens at higher
  effort. Larger regulations and higher depth increase both time and cost.
- **Throughput:** single background thread per job; fine for interactive
  single-user use. Concurrent jobs each get their own thread and job id.

---

## 18. Limitations & assumptions

- **Formats:** PDF, DOCX, TXT, MD only. No `.doc`, `.xlsx`, `.pptx`, images, or
  HTML (yet).
- **Slot roles are asymmetric:** the *regulation* slot is the source of
  obligations; the *policy* slot is graded. Swapping them is meaningless.
- **Single policy file per run.** The Logic doc envisions Policy + Procedure +
  SOP + annexures; currently one file is assessed.
- **Domain tuning:** the severity anchors in the evaluation prompt are
  financial-compliance flavoured. The engine generalizes to other domains
  (ISO 27001, GDPR, contracts) but severity calibration is best for
  regulatory/financial compliance.
- **Document size:** very large regulations may hit PDF page/size limits, get
  slow/costly, or generate a register big enough to risk output truncation
  (would need chunking).
- **Advisory, not authoritative.** It's an AI assessment with confidence scores;
  low-confidence items warrant human review. Documents are sent to OpenAI for
  processing.
- **State is ephemeral / single-process.** Restarting the server loses in-flight
  jobs; don't run multiple worker processes (the job store isn't shared).

---

## 19. Extensibility / roadmap

- **Multi-file policy** — accept several policy/procedure/SOP files and merge
  their content blocks before Stage 2.
- **More formats** — `.doc` (via conversion), `.xlsx`/`.pptx` (extractors),
  images (already vision-friendly), HTML.
- **Chunking** — split very large regulations across multiple extraction calls
  and de-duplicate obligations.
- **Domain-neutral / domain-aware prompts** — parameterize the severity anchors.
- **Report export** — server-side PDF/DOCX report (the code-execution or a
  templating library) beyond the current JSON/CSV.
- **A/B comparison** — assess two policies against one regulation side-by-side.
- **Persistence** — swap the in-memory job store for SQLite/Redis to survive
  restarts and support history.
- **Structured outputs** — move from JSON-mode to a strict JSON schema for even
  tighter output guarantees.

---

## 20. How to run

**Windows (easiest):** double-click **`Start Gap Tool.bat`** — it creates the
venv + installs deps on first run, then starts the server and opens the browser.

**PowerShell:** `./run.ps1` **·** **bash:** `./run.sh`

**Manual:**
```bash
python -m venv .venv && .venv\Scripts\activate      # or source .venv/bin/activate
pip install -r requirements.txt
# key is read from .env (OPENAI_API_KEY=...), or set it in the shell
python -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 8000
```
Then open **http://127.0.0.1:8000**, choose a regulation + policy (upload or the
sample chips), pick a depth, and **Run Assessment**.
