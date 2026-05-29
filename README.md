# Email Agent — Nomura SSG Agentic AI POC (Phase 1)

> Turns a noisy shared mailbox into clean, deduplicated, structured FX-settlement
> trade cases — automatically, deterministically, and explainably.

This is **Phase 1** of the Nomura SSG (Securities Services Group) Agentic AI
proof-of-concept. It triages a high-volume shared mailbox of `.eml` emails,
keeps the FX-settlement trade emails, discards office noise, flags the
borderline ones for human review, deduplicates by trade ID, and writes one
structured **case folder + `manifest.json` per trade** as the handoff to a
(future) Phase 2 extraction agent.

It ships in two forms:

* a **batch pipeline** (pure Python standard library) that reads `.eml` files
  from a local folder, and
* a **service layer** (FastAPI) consisting of a **mock Microsoft Graph API** and
  an **Email Agent API** that reads mail over HTTP — so the move to a live
  Outlook mailbox is a base-URL + credentials change, not a rewrite.

---

## Table of contents

1. [Business context](#1-business-context)
2. [What it delivers](#2-what-it-delivers)
3. [Solution overview](#3-solution-overview)
4. [Architecture](#4-architecture)
5. [The pipeline workflow](#5-the-pipeline-workflow)
6. [Classification logic (the core)](#6-classification-logic-the-core)
7. [Storage & deduplication contract](#7-storage--deduplication-contract)
8. [Service layer](#8-service-layer)
9. [API reference](#9-api-reference)
10. [Mock Microsoft Graph API](#10-mock-microsoft-graph-api)
11. [Logging & observability](#11-logging--observability)
12. [Configuration](#12-configuration)
13. [Installation & running](#13-installation--running)
14. [Testing](#14-testing)
15. [Synthetic test data](#15-synthetic-test-data)
16. [Project structure](#16-project-structure)
17. [Production path: going live on Microsoft Graph](#17-production-path-going-live-on-microsoft-graph)
18. [Security & access](#18-security--access)
19. [Limitations & roadmap](#19-limitations--roadmap)
20. [Tech stack](#20-tech-stack)

---

## 1. Business context

Nomura's Middle Office (MO) and Back Office (BO) teams process a high volume of
**FX settlement** emails — chiefly **Alleges / DK (Don't Know)** notices and
**SSI (Standard Settlement Instruction) verification** workflows. These land in
a **shared team mailbox**, mixed in with ordinary office traffic: meeting
invites, work anniversaries, IT tickets, out-of-office replies, and so on.

Today an analyst does this by hand, every cycle:

1. scan the inbox and pick out the genuine FX-settlement emails;
2. open each one (and its attachments — PDF, Excel, Word);
3. read off the trade fields (counterparty, notional, value date, rate, …);
4. re-key that data into downstream systems.

**The volume that makes this painful:** ~300–400 emails per processing cycle,
**4 cycles every 3 hours** — roughly **1,200–1,600 emails a day**. The work is
slow, repetitive, error-prone, and scales linearly with headcount.

**Phase 1 automates the first mile** of that workflow: reading the mailbox,
deciding what's relevant, and producing a clean, structured, deduplicated record
of each trade for the next phase to extract from.

---

## 2. What it delivers

| It does | It produces |
|---|---|
| Reads every incoming email | A uniform, parsed email record |
| Decides relevant vs. noise vs. borderline | `RELEVANT` / `AMBIGUOUS` / `IRRELEVANT` with a confidence and a reason |
| Extracts the trade identifier | e.g. `FXOPT-2026-00047` |
| Prevents duplicate processing | One case per trade, guaranteed idempotent |
| Hands off clean cases | A `manifest.json` per trade for Phase 2 |
| Records an audit trail | One structured JSON event per business action |

Two design commitments run through all of it:

* **Deterministic & explainable** — rule-based scoring, no LLM, no randomness.
  The same email always produces the same decision, and every decision comes
  with a human-readable reason. Zero per-email inference cost.
* **Conservative** — borderline emails are never silently dropped. They are
  labelled `AMBIGUOUS`, skipped, and surfaced for human review. It is better to
  flag a borderline email than to misclassify noise as a trade.

---

## 3. Solution overview

```
 .eml / Graph        Connector        Classifier        Dedup            Store
  (mailbox)    →     (parse)     →     (score)     →    (SQLite)    →    (disk)
                                                                            │
                                                                            ▼
                                                                   manifest.json
                                                                 (handoff to Phase 2)
```

An email enters one end. It either becomes a **structured case folder** or is
**discarded** — and the decision is fully traceable through the developer log
and the audit log.

The agent is a plain Python class (`EmailAgentRunner`) implementing a **SPAR
loop** — **S**ense → **P**lan → **A**ct → **R**eflect — over a flat list of
emails. There is deliberately **no orchestration framework**: the workload is a
sequential loop with no parallel branches, mid-run resumability, or multi-agent
coordination, so a plain, testable class is the right tool. Every component is
constructor-injected, which is what makes each one independently unit-testable
and swappable (e.g. local connector ↔ Graph connector).

---

## 4. Architecture

```
                        ┌──────────────────────────────────────────────┐
   source selector ───▶ │   source = "local"        source = "graph"    │
   (per request)        │        │                        │             │
                        │        ▼                        ▼             │
                        │  LocalEmailConnector      GraphConnector ──────┼──HTTP──┐
                        │  (reads .eml folder)      (OAuth2 + paged GET) │        │
                        └────────┬───────────────────────┬──────────────┘        │
                                 │   normalized email dict (identical shape)      │
                                 └───────────────┬────────────────────────┘       │
                                                 ▼                                 │
                                         RuleClassifier                            │
                                    (keyword / regex scoring)                      │
                                                 │                                 │
                          ┌──────────────────────┼──────────────────────┐         │
                          ▼                       ▼                      ▼         │
                     IRRELEVANT              AMBIGUOUS               RELEVANT       │
                     (skip + log)         (skip + flag for           │            │
                                            human review)            ▼            │
                                                            FileStore + DBIndex    │
                                                          (case folder + SQLite)   │
                                                                     │             │
                                                                     ▼             │
                                                              manifest.json        │
                                                            (Phase 2 contract)     │
                                                                                   │
   ┌───────────────────────────────────────────────────────────────────────────┐ │
   │                       FastAPI Email Agent API (:8000)                       │ │
   │   /classifier/classify   /connector/fetch   /agent/run   /storage/cases    │ │
   │   uniform success/failure envelope · correlation-id · dev log + audit log  │ │
   └───────────────────────────────────────────────────────────────────────────┘ │
                                                                                   ▼
                                                         ┌─────────────────────────────┐
                                                         │  Mock Microsoft Graph (:8001)│
                                                         │  token · messages · attach.  │
                                                         │  identical Graph v1.0 fields │
                                                         └─────────────────────────────┘
```

### Component breakdown

| Component | File | Responsibility |
|---|---|---|
| **Local connector** | `connectors/local_connector.py` | Parse every `*.eml` in the inbox into a uniform dict. Decodes MIME-encoded headers; never raises on a bad file (logs + skips). |
| **Graph connector** | `connectors/graph_connector.py` | Same output dict, sourced over HTTP from Microsoft Graph (or the mock): OAuth2 client-credentials → paged message fetch (follows `@odata.nextLink`) → per-message attachment fetch (base64-decode). |
| **Classifier** | `classifier/rule_classifier.py` | Deterministic keyword/regex scoring. Returns a `Classification` dataclass (label, confidence, reason, matched signals, trade_id). |
| **File store** | `storage/file_store.py` | Writes per-case artifacts (`email_body.txt`, `email_metadata.json`, `manifest.json`, raw attachments) under `data/processed/`. |
| **DB index** | `storage/db_index.py` | SQLite (`data/email_index.db`) for dedup + case tracking (`list_cases` / `get_case` / `count_by_status`). |
| **Agent runner** | `agent/email_agent.py` | The SPAR loop tying the above together; emits `RunStats` and audit events. |
| **Config** | `config/settings.py` | One `EmailAgentConfig` dataclass holding *all* tunables. Env-overridable. |
| **Mock Graph** | `mock_graph/` | FastAPI replica of the Graph v1.0 mail surface. |
| **Agent API** | `api/` | FastAPI exposing every module as an endpoint. |
| **Audit log** | `utils/audit.py` | Append-only structured business-event log. |
| **Dev log** | `utils/logger.py` | Human-readable developer logging (UTF-8 safe on Windows). |

**The normalized email dict** — the contract every connector produces and every
downstream component consumes — is:

```python
{
    "message_id":  "<FXOPT-2026-00047-UTIIFD0T@synthetic.local>",
    "subject":     "FX Trade Settlement[FXOPT-2026-00047] – USD/JPY – 26_05_26 - ...",
    "sender":      "Aastha Makkar (IND) <aastha.makkar@protivitiglobal.in>",
    "received_at": "2026-05-26T09:30:00Z",
    "body":        "Dear Team, Please find below the settlement details ...",
    "html_body":   "<html>...</html>",
    "attachments": [{"filename": "...", "data": b"...", "mime_type": "..."}],
    "source_file": "data/raw_emails/inbox/1.eml"   # or a Graph webLink
}
```

Because both connectors emit exactly this shape, **the classifier, store, and
dedup are unchanged whether the source is a local folder or a live mailbox.**
The connector pair is the *only* thing that differs between dev and production.

---

## 5. The pipeline workflow

The `EmailAgentRunner.run()` method, step by step:

1. **Sense** — `connector.fetch_emails()` returns the full list of normalized
   email dicts. The count is logged and an `agent.run.start` audit event is
   written.
2. **Plan + Act** — for each email:
   - **Already processed?** If `message_id` exists in SQLite, skip
     (`already_processed`) — this is what makes re-runs idempotent.
   - **Classify** the subject + body.
   - `IRRELEVANT` → log + skip (`irrelevant`).
   - `AMBIGUOUS` → log subject/score/reason, add to the review list, skip
     (`ambiguous`).
   - `RELEVANT` →
     - resolve the trade ID (or `UNKNOWN_<msgid-prefix>` if none);
     - **duplicate trade?** If the trade ID already exists, skip (`duplicate`);
     - otherwise **store the case**: create the case folder, write the body,
       metadata, raw attachments, and `manifest.json`, then insert the SQLite
       index row with `status = "ingested"`. Emit a `case.stored` audit event.
3. **Reflect** — log a run summary (counts per bucket + the ambiguous subjects
   for review) and emit an `agent.run.complete` audit event.

Every step in a single run shares one `correlation_id`, so the whole run can be
reconstructed from the audit log.

---

## 6. Classification logic (the core)

A transparent **additive scoring** system. Three signals contribute, and the
total is thresholded into a label. Note the deliberate asymmetry in *where* each
keyword list is matched — this is what cleanly separates real trades from
look-alikes.

| Signal | Matched against | Weight | Example |
|---|---|---|---|
| **Asset keywords** | subject **+** body | **+0.5** | `fx trade settlement`, `settlement instructions`, `deal reference`, `currency pair` |
| **Subject keywords** | subject **only** | **+0.3** | `settlement`, `confirm`, `trade`, `swift`, `counterparty`, `value date`, `fx` |
| **Trade-ID regex** | subject + first 2,000 body chars | **+0.2** | `FXOPT-2026-00047` |

Asset keywords are intentionally **specific multi-word phrases** ("settlement
**instructions**", not just "settlement"), so generic office noise can't earn
the strong +0.5 signal.

### Decision thresholds

```
score ≥ 0.70            →  RELEVANT    → extract & store
0.30 ≤ score < 0.70     →  AMBIGUOUS   → skip + flag for human review
score < 0.30            →  IRRELEVANT  → skip + log
```

### Hard-negative early exit

Before scoring, a fast rejection path runs: **if any negative keyword is present
AND no asset keyword is**, the email is immediately `IRRELEVANT` (confidence
0.9). Negative keywords include `happy birthday`, `anniversary`, `it support`,
`password`, `vpn`, `out of office`, `lunch`, `team sync`, etc. This stops obvious
noise before it can accumulate incidental subject-keyword points.

### Worked examples

| Email | Signals | Score | Label |
|---|---|---|---|
| `FX Trade Settlement[FXOPT-2026-00047] – USD/JPY` + full SSI body | asset + subject + trade-id | 0.5+0.3+0.2 = **0.95** | **RELEVANT** ✅ |
| `Settlement query – account reconciliation` | subject only (`settlement`) | **0.30** | **AMBIGUOUS** ⚠️ |
| `Happy Birthday Akshit 🎂` | negative keyword, no asset | early exit | **IRRELEVANT** ❌ |

### Trade-ID extraction

Patterns are tried in order; the first match wins:

1. `FXOPT-\d{4}-\d{5}` — the **ground-truth** format (`FXOPT-2026-00047`)
2. `[A-Z]{2,5}-\d{4}-\d{4,6}` — generic deal-reference fallback
3. `\b[A-Z]{2,4}\d{6,12}\b` — e.g. `FX123456`

A `RELEVANT` email with no extractable trade ID is stored under an
`UNKNOWN_<message-id-prefix>` id and is **not** deduplicated (we can't safely
dedupe what we can't identify).

All keyword lists, regex patterns, weights, and thresholds live in
`config/settings.py` — **change behaviour there, not in module internals.**

---

## 7. Storage & deduplication contract

### Case folder

Each `RELEVANT` email produces:

```
data/processed/{trade_id}_{asset_class}_{YYYYMMDD}/
├── email_body.txt          # raw plain-text body
├── email_metadata.json     # sender, subject, source, full classification
├── manifest.json           # the Phase 2 contract
└── attachments/            # raw attachment bytes (saved, not yet parsed)
```

The folder date is the **processing date** (when the agent ran), not the email's
received date.

### `manifest.json` — the Phase 2 contract

```json
{
  "trade_id": "FXOPT-2026-00047",
  "asset_class": "FX Settlement",
  "message_id": "<FXOPT-2026-00047-UTIIFD0T@synthetic.local>",
  "subject": "FX Trade Settlement[FXOPT-2026-00047] – USD/JPY – 26_05_26 - ...",
  "sender": "Aastha Makkar (IND) <aastha.makkar@protivitiglobal.in>",
  "received_at": "2026-05-26T09:30:00Z",
  "case_folder": "data/processed/FXOPT-2026-00047_FX_Settlement_20260526",
  "email_body_path": ".../email_body.txt",
  "attachments": [ { "filename": "...", "path": "...", "mime_type": "...", "size_bytes": 0 } ],
  "classification": { "label": "RELEVANT", "confidence": 0.95, "reason": "...", "asset_class": "FX Settlement" },
  "ready_for_extraction": true
}
```

Phase 2 scans `data/processed/` for manifests where `ready_for_extraction == true`.

### SQLite index & idempotency

The `email_cases` table tracks every stored case (message_id `UNIQUE`, trade_id,
asset_class, subject, sender, received_at, classification label/confidence,
case_folder, attachment_count, processed_at, and a `status` that progresses
`ingested → extracted → matched` as later phases run).

**Two guards make every run idempotent** — safe to run every 3-hour cycle with
nothing processed twice:

* `message_id_exists` — skip an email already processed on a previous run;
* `trade_id_exists` — skip a *different* email for a trade already captured;
* `insert_case` uses `INSERT OR IGNORE` so a racing duplicate can never raise.

---

## 8. Service layer

Two FastAPI applications. The mock stands in for Microsoft Graph in dev; the
agent API exposes the pipeline.

```
┌──────────────┐    HTTP (OAuth2 + Graph v1.0)    ┌─────────────────────┐
│  Email Agent │ ───────────────────────────────▶ │  Mock Microsoft     │
│  API  :8000  │   token / messages / attachments  │  Graph API   :8001  │
└──────────────┘                                   └─────────────────────┘
        │                                                     ▲
        │ classify · fetch · run · storage                    │ parses .eml at startup
        ▼                                                     │
   case folders + manifest.json                         data/raw_emails/inbox
```

Why a mock at all? Live Graph access to Nomura's mailbox needs IT approvals and
OAuth2 credentials, which take time. Rather than block development, the mock
returns **byte-for-byte Graph-shaped JSON** built from the same synthetic `.eml`
files. Code written against the mock runs unchanged against production Graph.

---

## 9. API reference

### Uniform response envelope

**Every** Email Agent API response — success or failure — has the same shape:

```json
{
  "status": "success",
  "data": { "...": "endpoint-specific payload" },
  "error": null,
  "correlation_id": "5f0c…",
  "timestamp": "2026-05-27T07:03:50Z"
}
```

On failure: `status` is `"error"`, `data` is `null`, and `error` is
`{ "code", "message" }`. This holds for **all** failure modes — request
validation (HTTP 422), not-found (404), and unexpected errors (500) — so a
caller never has to special-case the error shape.

Send an `X-Correlation-ID` header to thread your own id through the logs, the
audit trail, and the response; otherwise one is generated and returned in the
`X-Correlation-ID` response header.

### Endpoints (`:8000`)

| Method & path | Purpose | Returns |
|---|---|---|
| `GET  /health` | Liveness + configured source / Graph URL | raw status (not enveloped) |
| `POST /classifier/classify` | Classify a `{subject, body}` | label, confidence, reason, matched signals, trade_id |
| `POST /connector/fetch` | Fetch (no store) from `{source: local\|graph}` | per-email summaries + count |
| `POST /agent/run` | Run the full pipeline from `{source}` | `RunStats` (read/relevant/ambiguous/irrelevant/duplicate/already_processed) |
| `GET  /storage/cases` | List stored cases | cases + counts by status |
| `GET  /storage/cases/{trade_id}` | One case + its `manifest.json` | case row + manifest (404 if absent) |
| `GET  /storage/stats` | Case totals by status | totals |

### Examples

```bash
# Positive vs. negative classification (success envelope, opposite verdicts)
curl -s localhost:8000/classifier/classify -H 'content-type: application/json' \
  -d '{"subject":"FX Trade Settlement[FXOPT-2026-00047]","body":"Settlement Instructions: SWIFT BARCGB22"}'
#  → data.label = "RELEVANT", data.trade_id = "FXOPT-2026-00047"

curl -s localhost:8000/classifier/classify -H 'content-type: application/json' \
  -d '{"subject":"Happy Birthday Akshit!","body":"Cake at 4pm"}'
#  → data.label = "IRRELEVANT"

# Full pipeline over the Graph source
curl -s localhost:8000/agent/run -H 'content-type: application/json' -d '{"source":"graph"}'
#  → data.stats = { read:27, relevant:12, ambiguous:3, irrelevant:10, duplicate:2, ... }

# A failure path — returns the SAME envelope shape with status:"error"
curl -s localhost:8000/storage/cases/NOPE-9999      # → 404, error.code = "CaseNotFound"
```

Interactive Swagger UI: **http://localhost:8000/docs**.

---

## 10. Mock Microsoft Graph API

Replicates the Graph v1.0 mail surface the agent needs, with **identical JSON
field names**, so the production swap is base-URL + credentials only. The `.eml`
files in the inbox are parsed into Graph-shaped records once at startup
(`mock_graph/eml_to_graph.py`); responses are rendered on demand so `$select`,
`$expand`, and the `Prefer` header behave like real Graph.

### Endpoints (`:8001`)

| Method & path | Notes |
|---|---|
| `POST /{tenant}/oauth2/v2.0/token` | client-credentials grant → `access_token` |
| `GET  /v1.0/users/{mailbox}/messages` | list; `$top`/`$skip` paging → `@odata.nextLink`, `$select`, `$count` |
| `GET  /v1.0/users/{mailbox}/mailFolders/{folder}/messages` | same, folder-scoped |
| `GET  /v1.0/users/{mailbox}/messages/{id}` | single message; `$expand=attachments` |
| `GET  /v1.0/users/{mailbox}/messages/{id}/attachments` | attachment list (base64 `contentBytes`) |
| `GET  /v1.0/users/{mailbox}/messages/{id}/attachments/{aid}` | single attachment |

Bearer auth is enforced on all `/v1.0` routes (401 with a Graph-shaped error
when missing). Send `Prefer: outlook.body-content-type="text"` to get a
plain-text body (which is what the classifier wants).

### Graph fidelity & field mapping

A real Graph message carries dozens of fields; the connector maps these to the
normalized dict:

| Normalized field | Graph source |
|---|---|
| `message_id` | `internetMessageId` (stable RFC-5322 id — used for dedup) |
| `subject` | `subject` |
| `sender` | `from.emailAddress` (`name` + `address`) |
| `received_at` | `receivedDateTime` (ISO-8601 UTC) |
| `body` | `body.content` (with `body.contentType` selecting text/html) |
| `attachments[].filename` | attachment `name` |
| `attachments[].data` | `base64decode(contentBytes)` |
| `attachments[].mime_type` | attachment `contentType` |

**Three Graph gotchas the mock faithfully reproduces** (so the connector handles
them before production): attachments are a *separate* call (not inline by
default); the body is HTML unless you ask for text via `Prefer`; and the message
`id` is **not** stable across folder moves, which is why dedup keys on
`internetMessageId`.

---

## 11. Logging & observability

Two **separate** streams, by design:

### Developer log — `logs/email_agent_<date>.log` (+ console)

Human-readable, level-gated (DEBUG/INFO/WARNING). Exists to debug the *logical
flow* — what the classifier scored, why an email was skipped. Verbose, mutable,
free to change as the code evolves. `utils/logger.py` reconfigures stdout/stderr
to UTF-8 so Windows consoles don't crash on em-dashes/emojis.

### Audit log — `logs/audit_<date>.log`

Append-only, **one JSON object per business event**, never level-gated. Answers
the compliance question: *who* did *what*, to *which* resource, *when*, and did
it *succeed*. The field set is a **contract** (add fields, never repurpose):

```json
{
  "timestamp": "2026-05-27T07:03:50Z",
  "event_id": "fc76…",
  "correlation_id": "87b0…",
  "actor": "system",
  "action": "case.stored",
  "resource": "FXOPT-2026-00047",
  "outcome": "success",
  "details": { "confidence": 0.95, "message_id": "<…@synthetic.local>" }
}
```

Emitted actions include `agent.run.start`, `agent.run.complete`,
`email.classified` (success/skipped), `case.stored`, and `api.request`. Every
event in one request/run shares a `correlation_id`, so a single run can be
reconstructed end-to-end across the dev log, the audit log, and the API
response header. In production these ship to a WORM store / SIEM (Splunk,
Microsoft Sentinel) rather than a local file.

---

## 12. Configuration

Everything tunable lives in the `EmailAgentConfig` dataclass
(`config/settings.py`) and is environment-overridable (12-factor friendly). No
real credentials live in the repo — the mock uses placeholder values.

| Env var | Default | Meaning |
|---|---|---|
| `EMAIL_SOURCE` | `local` | Default source when unspecified (`local` \| `graph`) |
| `EMAIL_INBOX_PATH` | `data/raw_emails/inbox` | `.eml` folder (local source + the mock's source) |
| `EMAIL_PROCESSED_PATH` | `data/processed` | Case-folder output root |
| `EMAIL_DB_PATH` | `data/email_index.db` | SQLite dedup/index DB |
| `EMAIL_LOG_DIR` | `logs` | Developer log directory |
| `EMAIL_AUDIT_LOG_DIR` | = `EMAIL_LOG_DIR` | Audit log directory |
| `GRAPH_BASE_URL` | `http://localhost:8001` | Graph endpoint the API/connector call |
| `GRAPH_MAILBOX` | `mo-team@nomura.com` | Mailbox to read |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | mock values | OAuth2 client-credentials |
| `GRAPH_FOLDER` | `inbox` | Mail folder to read |

In-code tunables (not env vars): the keyword lists, `trade_id_patterns`, the
weights (`asset_weight=0.5`, `subject_weight=0.3`, `trade_id_weight=0.2`), the
thresholds (`relevant_threshold=0.7`, `ambiguous_threshold=0.3`), and
`graph_page_size=10`.

---

## 13. Installation & running

**Requires Python 3.11+** (developed on CPython 3.13). **All commands run from
inside `email_agent/`** — imports are absolute against that directory and
`uvicorn`/`pytest` resolve packages from the working directory.

```bash
pip install -r requirements.txt
```

### Batch pipeline (no services needed)

```bash
python tools/generate_test_emails.py --clean   # build the synthetic inbox
python demo.py                                  # run + prove deduplication
python main.py                                  # single run, no reset
```

`demo.py` is the canonical smoke test: it regenerates the inbox, runs the agent
(expect **12 relevant / 3 ambiguous / 10 irrelevant / 2 duplicate**), then
re-runs to prove dedup (**0 stored, 12 already processed**).

### Service layer (two processes)

```bash
# Terminal 1 — mock Graph
python -m uvicorn mock_graph.app:app --port 8001

# Terminal 2 — agent API, pointed at the mock
#   PowerShell:  $env:GRAPH_BASE_URL="http://localhost:8001"; python -m uvicorn api.app:app --port 8000
#   bash:        GRAPH_BASE_URL=http://localhost:8001 python -m uvicorn api.app:app --port 8000
python -m uvicorn api.app:app --port 8000
```

Then browse **http://localhost:8000/docs** (agent API) and
**http://localhost:8001/docs** (mock Graph). Full endpoint reference:
[`SERVICES.md`](SERVICES.md).

---

## 14. Testing

```bash
python -m pytest          # 26 tests
```

The suite (config in `pytest.ini`, `pythonpath = .`) is the most thorough
"is everything working" check. `tests/conftest.py`:

* redirects **all write paths** (processed/, the DB, logs) to a temp dir via env
  *before* importing app modules, so tests never touch real data;
* regenerates the deterministic 27-email inbox once per session (seed 42);
* runs the **mock Graph service as a real uvicorn server** in a background
  thread, so the synchronous `GraphConnector` exercises a genuine HTTP round
  trip — not a stub.

Coverage spans the `.eml`→Graph converter, the mock's Graph-shape fidelity (auth
401s, paging, `$select`, `Prefer`, 404s), the `GraphConnector` (27 emails,
paging followed, normalized shape), and the API end-to-end (classify
positive/negative, fetch local + graph, full run, storage, idempotent re-run,
and the audit trail). CI (`.github/workflows/ci.yml`) runs the suite on Python
3.11, 3.12, and 3.13 on every push and PR.

---

## 15. Synthetic test data

`tools/generate_test_emails.py` builds the inbox using only the stdlib
`email.message` module — no third-party deps. It mirrors the structure of the
real sample emails and emits a deterministic, seeded mix:

| Category | Count | Purpose |
|---|---|---|
| RELEVANT — complete | 8 | full trade details, clear trade ID |
| RELEVANT — partial | 4 | 1–2 fields blanked, still clearly FX |
| AMBIGUOUS | 3 | settlement-adjacent, no clear trade context |
| IRRELEVANT | 10 | birthdays, IT tickets, HR, OOO, lunch… |
| DUPLICATE | 2 | reused trade IDs, fresh message IDs (tests dedup) |
| **Total** | **27** | |

The emails are written with **neutral numeric filenames** (`1.eml`, `2.eml`, …)
and **shuffled** so the categories are interleaved — the inbox looks like a
real, unsorted mailbox, and the category is decided by the agent at runtime, not
leaked by the filename or the on-disk order.

When changing classifier keywords or thresholds, regenerate the inbox and re-run
`demo.py` to confirm the expected 12/3/10/2 split still holds.

---

## 16. Project structure

```
email_agent/
├── agent/
│   └── email_agent.py          # EmailAgentRunner — the SPAR loop
├── api/                        # Email Agent FastAPI
│   ├── app.py                  # app, middleware (correlation id + audit), exception handlers
│   ├── deps.py                 # connector factory + overridable config
│   ├── models.py               # Pydantic models + success/failure Envelope
│   └── routers/                # one router per module
│       ├── classifier.py
│       ├── connector.py
│       ├── agent.py
│       └── storage.py
├── classifier/
│   └── rule_classifier.py      # scoring + trade-ID extraction
├── config/
│   └── settings.py             # EmailAgentConfig (all tunables, env-overridable)
├── connectors/
│   ├── local_connector.py      # .eml folder  → normalized dict
│   └── graph_connector.py      # Graph/mock   → normalized dict (over HTTP)
├── mock_graph/                 # mock Microsoft Graph FastAPI
│   ├── app.py                  # token / messages / attachments endpoints
│   └── eml_to_graph.py         # .eml → Graph-shaped JSON
├── storage/
│   ├── file_store.py           # case-folder writer
│   └── db_index.py             # SQLite dedup + case tracking
├── tools/
│   └── generate_test_emails.py # synthetic inbox generator (dev tool)
├── utils/
│   ├── logger.py               # developer logging (UTF-8 safe)
│   └── audit.py                # append-only audit logging
├── tests/                      # pytest suite (26 tests) + conftest
├── data/                       # (gitignored) inbox, processed cases, SQLite db
├── logs/                       # (gitignored) developer + audit logs
├── demo.py                     # end-to-end batch demo
├── main.py                     # single batch run
├── requirements.txt
├── pytest.ini
├── SERVICES.md                 # service-layer / endpoint reference
└── README.md                   # this file
```

Runtime artifacts (`data/`, `logs/`, `*.db`, `__pycache__/`, `.env`) are
gitignored — they're regenerable from the generator and the pipeline.

---

## 17. Production path: going live on Microsoft Graph

The connector swap is the easy part (`GRAPH_BASE_URL` → `https://graph.microsoft.com`
plus real credentials). The substantive work is **how the agent tracks an
incoming stream** at production volume (1,200–1,600 emails/day), where you cannot
re-scan the whole mailbox every cycle.

**Shift from "rescan + dedup" to incremental sync against a durable cursor:**

* **Delta query** (the primary mechanism) — call
  `/messages/delta`; Graph returns a `@odata.deltaLink` cursor. Persist it (the
  SQLite DB is the natural home), and each cycle fetch *only* what changed since
  last sync. This replaces "glob the folder." **Advance the cursor only after a
  batch is durably processed**, or a crash will skip mail.
* **Change notifications / webhooks** (optional, for latency) — Graph pushes a
  "message arrived" to an HTTPS endpoint in near-real-time. Best-effort and
  expiring (~3 days, must be renewed), so they *trigger* a fetch but never
  replace the delta sync that underpins correctness. **Pull is the source of
  truth; push only lowers latency.**

**Recommended starting point for a bank:** *delta query on a short timer*
(every 30–120s). It's near-real-time, **outbound-only** (no inbound firewall
exception / public endpoint — usually the hardest thing to get approved), and
reuses the existing idempotent `message_id` design. Add webhooks later only if a
concrete sub-minute-latency requirement demands it.

**Why the existing schema already fits a live stream:** the `message_id UNIQUE`
+ `INSERT OR IGNORE` design gives *effectively-once* processing for free (delta
and webhooks both deliver at-least-once), and the per-row `status` column is the
state machine for tracking where each message is across phases.

**One classification nuance for live mail:** today a second email with the same
trade ID is dropped as a `DUPLICATE` (first-write-wins). In a real mailbox the
*complete* details often arrive as a follow-up to a *partial* first email — so a
"duplicate trade ID" can be an **update** that should enrich the existing case
rather than be discarded. Keying cases on trade ID + tracking the
`conversationId` thread, and deciding update-vs-skip, is the first place the
system becomes genuinely *agentic* (a decision, not a fixed rule).

---

## 18. Security & access

* **No secrets in the repo.** The mock uses placeholder credentials. Real Graph
  `client_secret`/tenant must live in a secret store (GitHub Actions Secrets,
  or better Azure Key Vault) and be injected as env vars — which the config
  already reads.
* **Least-privilege Graph access** in production: app-only auth
  (client-credentials), `Mail.Read`, scoped to the single shared mailbox via an
  **application access policy**. Keep the mailbox **read-only** and hold
  processing state in your own store rather than mutating a shared mailbox.
* **The Email Agent API itself currently has no auth** — acceptable for a local
  POC, but it must sit behind authentication before any shared deployment.
* **Audit everything** — the audit log is the compliance spine; ship it to a
  WORM/SIEM in production.

---

## 19. Limitations & roadmap

**Known limitations (honest framing):**

* **Rule-based, not AI** — fast, free, deterministic, explainable; but no
  semantic understanding. The `AMBIGUOUS` bucket is flagged for humans, not
  resolved.
* **Attachments are stored raw, not parsed** — there is no attachment-content
  extractor yet; the bytes are saved for Phase 2.
* **`/agent/run` is synchronous** — it blocks until the batch completes. Fine at
  27 emails; production volume wants a background job.
* **Validated on synthetic data** — generated to match the structure of the real
  samples, but not yet run against a live mailbox.

**Roadmap:**

* **Phase 1 remaining** — attachment-content extractor; validate on live samples.
* **Phase 2** — Extraction Agent: body + attachments → the trade fields → JSON.
* **Phase 3** — Compare & match against golden sources, with confidence scoring.
* **Phase 4** — Human-in-the-loop review UI (and LLM resolution of the
  `AMBIGUOUS` bucket).
* **Phase 5–8** — Orchestration, feedback loop, ServiceNow integration,
  observability.

---

## 20. Tech stack

| Layer | Technology |
|---|---|
| Language | Python 3.11+ (developed on 3.13) |
| Email parsing | `email` (stdlib) |
| Classification | `re` + keyword scoring (stdlib, no LLM) |
| Storage / dedup | `sqlite3` (stdlib) |
| Synthetic data | `email.message` (stdlib) |
| API & mock Graph | FastAPI + Uvicorn |
| HTTP client | httpx |
| Form parsing (token endpoint) | python-multipart |
| Testing | pytest |
| CI | GitHub Actions (Python 3.11 / 3.12 / 3.13) |

The **batch pipeline core is pure standard library**; third-party dependencies
exist only for the service layer (FastAPI, Uvicorn, httpx, python-multipart) and
testing (pytest).

---

*Phase 1 — Email Agent · Nomura SSG Agentic AI POC · FX & OTC Settlement*
