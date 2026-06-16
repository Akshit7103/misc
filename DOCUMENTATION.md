# Agentic Capabilities — FX Trade Settlement (Triage · Extract · Reconcile)
### Nomura SSG · Agentic AI Proof of Concept (Phase 1)

A working, end-to-end system that watches a shared FX/OTC settlement mailbox, **separates real trade-settlement emails from office noise**, **deduplicates by trade**, **extracts the individual trades** — from both the email body and its Excel/CSV attachments — and **reconciles** each trade against a trusted *golden source*, populating missing fields and flagging breaks. The output is a clean, structured, source-attributed **trade register** ready for the next stage of automation.

It also ships two forward-looking, **showcase-only** surfaces: a **one-click Run console** that drives the whole pipeline end-to-end, and a **visual Workflow Builder** (drag-and-drop canvas + capability blocks) that previews the "agent marketplace" vision.

This document is the single source of truth for **what has actually been built so far**. Two audiences:

| If you are… | Read… |
|---|---|
| **Business / operations / leadership** | §1 Executive Summary · §2 The Problem · §3 What It Does · §4 Demo Walkthrough · §15 What's Built vs Not · §16 Roadmap |
| **Technical / engineering** | §5 Architecture onwards (agent, classifier, extractor, reconciliation, storage, API, frontend, builder, running, testing) |

> Scope note: This is **Phase 1**, a proof of concept on **synthetic, non-production data** that mirrors the real settlement-email shapes. The mailbox is a local `.eml` folder or a field-identical mock Microsoft Graph API (real Graph is a config swap, not yet wired). Forward-looking items are clearly marked in §16.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Business Problem](#2-the-business-problem)
3. [What the Platform Does](#3-what-the-platform-does)
4. [Demo Walkthrough](#4-demo-walkthrough)
5. [System Architecture](#5-system-architecture)
6. [The Agent — the SPAR Loop](#6-the-agent--the-spar-loop)
7. [The Classification Engine](#7-the-classification-engine)
8. [Extraction — Attachments & Body](#8-extraction--attachments--body)
9. [Reconciliation — "Recon Compare & Match"](#9-reconciliation--recon-compare--match)
10. [Storage, Deduplication & the Phase-2 Handoff](#10-storage-deduplication--the-phase-2-handoff)
11. [The Service Layer — Mock Graph & the Dev↔Prod Swap](#11-the-service-layer--mock-graph--the-devprod-swap)
12. [The Agent API & Observability](#12-the-agent-api--observability)
13. [The Frontend — Pipeline, Run Console, Configure Workflows](#13-the-frontend--pipeline-run-console-configure-workflows)
14. [The Visual Workflow Builder & Marketplace (showcase)](#14-the-visual-workflow-builder--marketplace-showcase)
15. [What's Built vs Not Built](#15-whats-built-vs-not-built)
16. [How We Proceed Further (Roadmap)](#16-how-we-proceed-further-roadmap)
17. [Running the System](#17-running-the-system)
18. [Testing & Quality](#18-testing--quality)
19. [Project Structure](#19-project-structure)
20. [Glossary](#20-glossary)

---

## 1. Executive Summary

**The pain.** A Middle-Office settlement team shares a single mailbox. Into it flow genuine FX/OTC trade-settlement notifications — each needing timely action — mixed with constant office noise (IT tickets, newsletters, calendar invites, birthday emails). A person reads every message, decides what is a real trade, opens attachments, copies trade details into downstream systems, checks them against the firm's records, and avoids acting twice. It is slow, repetitive, error-prone, and does not scale.

**What we built.** An **AI agent** that does the first mile automatically and explainably:

1. **Connects** to the mailbox (today: a folder of `.eml` files or a mock Microsoft Graph API that is field-identical to the real one).
2. **Classifies** every email — *Relevant*, *Ambiguous* (held for a human), or *Irrelevant* — using transparent, tunable rules (no black-box model).
3. **Extracts** the trades — structured fields from both the email body **and** its Excel/CSV attachments, where one attachment can carry a blotter of 30+ trades.
4. **Reconciles** each extracted trade against a trusted **golden source** — populating fields the email never carried, comparing the fields it did, and flagging **breaks** with a confidence score.
5. **Deduplicates** by trade ID and **stores** each result as a structured **case folder + manifest** — the clean handoff to the next stage.

**The result, on the current demo dataset:** a noisy inbox of **29 emails** is triaged into **14 relevant**, **3 ambiguous (held for review)**, **10 irrelevant**, **2 duplicates**; the relevant emails yield an **80-row trade register** (12 from email **bodies**, 68 from **Excel attachments**); and reconciliation against a 100-row golden blotter yields **68 matched**, **12 breaks**, with **179 fields auto-populated** from the golden source.

**Why it matters.** Every decision is **auditable** (an append-only compliance log records who/what/when/outcome), **explainable** (each classification and match states the signals that drove it), and **tunable by the business** (an operations user edits keywords live and sees the result change). The connector is the *only* thing that changes between this demo and a live mailbox.

**Maturity.** A proof of concept with a real backend, a real UI, and **75 automated tests passing**. Not yet connected to production mailboxes or downstream settlement systems — see §15–§16.

---

## 2. The Business Problem

Settlement operations run on email. Counterparties, custodians, and internal desks send **Standard Settlement Instructions (SSIs)**, trade confirmations, and settlement notifications to shared team mailboxes. For each one, an analyst must:

- **Triage** — is this a real trade that needs action, or noise?
- **Read attachments** — the actual economics often live in an Excel/CSV "blotter" attached to a short cover email, not in the body.
- **Extract** — copy trade ID, counterparty, currency pair, notional, settlement date, etc. into the settlement workflow.
- **Reconcile** — check the trade against the firm's record of truth; spot missing or mismatched fields (a "break").
- **De-duplicate** — the same trade arrives multiple times (original + forward + chase-up); acting twice causes breaks.
- **Escalate** — when genuinely unclear, a human decides; nothing must be silently dropped.

At volume this is hours of repetitive reading per day, with operational-risk consequences if a real settlement email is missed or a trade is double-booked. **This agent automates the triage, first-pass extraction, and reconciliation, while keeping a human in the loop for the genuinely ambiguous cases.**

---

## 3. What the Platform Does

The product surfaces one core capability — **FX Trade Settlement** — as a guided pipeline, plus **Configure Workflows** where the business runs and tunes it.

### The pipeline (four steps)

| Step | What happens | Business value |
|---|---|---|
| **1 · Sync Emails** | Pull all emails from the mailbox (local `.eml` folder or the Graph API). | A live view of the raw inbox — nothing hidden. |
| **2 · Classify** | Score and label every email **Relevant / Ambiguous / Irrelevant**, with a reason; flag duplicates. | Cuts the noise; surfaces only what needs action; never silently drops the unclear ones. |
| **3 · Extract Trade Data** | Parse each relevant email + its Excel/CSV attachments into a **trade register** — one row per trade, with a **Source** column. | A clean, structured handoff — the analyst no longer copies fields by hand. |
| **4 · Recon Compare & Match** | Match each trade by ID against a **golden source**; populate missing fields and flag breaks with a confidence. | Completes the record and surfaces discrepancies for review. |

Plus, on **Configure Workflows**:
- **Run** — kick off the whole 4-step pipeline end-to-end in one click (an animated **Run console**).
- **Edit / Add Workflow** — open the **visual Workflow Builder** (showcase) to assemble a pipeline from capability blocks.
- Edit the agent's **shortlisting keywords**, fields, and cadence (drives the live classifier).

### The principles that make it trustworthy

- **Explainable, not a black box.** Classification is rule-based scoring; reconciliation shows exactly which fields agreed, broke, or were filled. A reviewer can always answer "why?"
- **Human-in-the-loop by design.** Anything in the middle band is **Ambiguous** and **held for review**, logged, never discarded.
- **Idempotent & safe.** Re-running never duplicates or double-counts a trade.
- **Tunable by the business.** Keyword edits take effect on the next run, no redeploy.
- **Audit-ready.** Every business action writes a structured, append-only audit event.

---

## 4. Demo Walkthrough

The whole stack starts with one double-click of **`launch.bat`**, which opens the app at **http://localhost:3000**.

1. **Login.** Branded sign-in (Protiviti) — placeholder auth for the PoC. The top-right avatar opens an account menu with **Logout**.

2. **FX Trade Settlement → Sync Emails.** Choose source — **Local (.eml)** or **Graph API** — and Sync. The inbox shows **29 emails** (genuine settlement emails + office noise). Click any row to preview.

3. **Classify.** Run the classifier → **14 Relevant · 3 Ambiguous · 10 Irrelevant · 2 Duplicates**, each with confidence + a plain-language reason. A run-log drawer shows the agent's reasoning.

4. **Extract Trade Data.** An **80-row register** — **12** parsed from email bodies (`Source = Body`), **68** from two Excel blotters (`Source = Attachment (xlsx)`). Columns: Trade ID · UTI · Trade Date · Counterparty · Currency Pair · Buy/Sell · Notional · Notional Ccy · Settlement Date · **Source**. Click a row for full detail.

5. **Recon Compare & Match.** Each trade is matched by ID to the **golden source** (a 100-row master blotter). The drawer shows the **completed trade record** (fields filled from golden are tagged), a **"populated from golden source"** list, and a **field-comparison table** (agree / break). On the demo data: **68 matched, 12 breaks, 179 fields populated**, with status badges (Matched / Enriched / Near-match / Break / Unmatched) and a confidence bar.

6. **Configure Workflows.** Lists the **FX Trade Settlement** workflow with **Run · View · Edit · Delete** actions.
   - **Run** → the **Run console** executes Sync → Classify → Extract → Recon Compare & Match sequentially with animated per-stage status, then "View results" jumps to the populated pipeline.
   - **Edit / Add Workflow** → the **visual Workflow Builder** (see §14).

> **Demo tip:** delete `data/processed/` and re-run Classify — the agent **self-heals**, rebuilding every case folder and manifest. A repeatable "clean run."

---

## 5. System Architecture

Two cooperating tiers: a **Python backend** (agent + API + mock Graph) and a **Next.js frontend**, deliberately decoupled.

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Browser — Next.js UI (:3000)                  │
│  Login → FX Trade Settlement (Sync → Classify → Extract → Recon C&M)   │
│          Configure Workflows (Run console · Workflow Builder) · …      │
└───────────────┬──────────────────────────────────────────────────────┘
                │  /api/backend/*   (Next.js rewrite proxy → :8000, no CORS)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Agent API — FastAPI (:8000)                      │
│ /classifier /connector /agent /extract /match /storage /config /health │
│  correlation-id middleware · developer log · audit log · uniform JSON   │
└───────┬───────────────────────────────────────────────┬───────────────┘
        │ source = local                                 │ source = graph
        ▼                                                ▼
┌────────────────────┐                       ┌────────────────────────────────┐
│ LocalEmailConnector │                      │ GraphConnector (OAuth2 + paging) │
│  reads .eml inbox   │                      │   → Mock Graph API (:8001)        │
└────────┬───────────┘                       │     ≡ Microsoft Graph v1.0 shape  │
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  EmailAgentRunner  —  SPAR loop                         │
│   RuleClassifier → AttachmentExtractor → FileStore + DBIndex            │
└───────┬───────────────────────────────────────────────┬───────────────┘
        ▼                                                 ▼
  data/processed/<case>/                            data/email_index.db
   ├ manifest.json · email_body.txt                  (SQLite: dedup + cases)
   ├ attachments/<files> · extracted_trades.json
        │
        ▼  (post-extraction, on demand)
┌──────────────────────────────────────────────────────────────────────┐
│   CompareMatcher  (+ body_extractor)   →   GoldenSource                 │
│   match by trade_id → enrich missing fields → compare → status/score   │
│   data/golden/FX_Options_Trade_masterDataset.xlsx  (mock golden source) │
└──────────────────────────────────────────────────────────────────────┘
```

**Design choices that matter:**

- **No orchestration framework.** The agent is plain Python — a readable SPAR loop with **constructor-injected** components. Each piece is independently testable and replaceable.
- **The connector is the only dev↔prod seam.** Local `.eml` and live Microsoft Graph emit the *same* uniform email dict. Going live is a base-URL + credentials change.
- **Frontend ↔ backend over a proxy.** Next.js rewrites `/api/backend/*` → `:8000` (same-origin, no CORS).
- **Single config object.** All tunables (keywords, weights, thresholds, paths, Graph settings, golden source, match fields) live in one `EmailAgentConfig`, env-overridable, runtime-editable.

---

## 6. The Agent — the SPAR Loop

`agent/email_agent.py` → `EmailAgentRunner`, a classic **SPAR** loop:

| Phase | What it does |
|---|---|
| **Sense** | Fetch all emails from the injected connector into a uniform list. |
| **Plan** | For each email, decide the path: already-processed? → skip (or self-heal). New? → classify. |
| **Act** | Classify → for *Relevant* emails, deduplicate, store the case (body + metadata + attachments + extracted trades + manifest), and index it. |
| **Reflect** | Log a structured run summary and write audit events for the whole run. |

**Notable behaviours:** idempotent re-runs (`INSERT OR IGNORE` + `message_id`/`trade_id` guards), **self-heal** (rebuilds a missing case folder from the index, emits `case.restored`), and **collision-free fallback IDs** (a blotter email with no subject trade ID gets a stable `UNKNOWN_<hash>` from the *full* message ID).

---

## 7. The Classification Engine

`classifier/rule_classifier.py` → `RuleClassifier`. Deterministic, transparent **additive scoring** — no LLM. Every weight, keyword, and threshold lives in `EmailAgentConfig` and is editable at runtime.

| Signal | Matched against | Weight |
|---|---|---|
| **Asset keywords** (`"fx trade settlement"`, `"deal reference"`, …) | subject **and** body | **+0.5** |
| **Subject keywords** (`"settlement"`, `"confirm"`, `"trade"`, …) | subject **only** | **+0.3** |
| **Trade-ID regex** (primary `FXOPT-\d{4}-\d{5}`) | subject + first 2000 body chars | **+0.2** |

```
score ≥ 0.70           → RELEVANT     (kept, stored)
0.30 ≤ score < 0.70    → AMBIGUOUS    (held for human review, logged)
score < 0.30           → IRRELEVANT   (dropped)
```

A **hard-negative early exit** runs first: any negative keyword (`"happy birthday"`, `"it support"`, …) **and** no asset keyword → immediate `IRRELEVANT`. Each result returns label, confidence, a human-readable reason, matched keywords, and any extracted trade ID. **Tunable live** from Configure Workflows.

> Roadmap: the BRD calls for **context-aware (LLM) intent classification**, not keyword scoring. The rule engine is the auditable backbone; an LLM assist for the ambiguous band is the planned upgrade (§16).

---

## 8. Extraction — Attachments & Body

Real settlement emails pair a short cover note with the trades in an **attachment** (a "blotter", one row per trade). Single-trade emails carry the fields in the body. The agent handles both.

### Attachment extractor — `agent/attachment_extractor.py`
- **Excel** (`.xlsx`, `.xlsm`) via `openpyxl` (read-only, data-only); **CSV** via stdlib. PDF is out of scope (vector SSIs need OCR — §16).
- **Never raises** — every failure returns a structured `ExtractionResult` with a `status` (`success`/`empty`/`unsupported`/`error`).
- **Header auto-detection** (tolerates a banner row above the headers), **column mapping** (`"Cpty"`→counterparty, `"Value Date"`→settlement_date, …), and **source-agnostic normalization** (a CSV string `"897,327.00"` and a native Excel number normalize to the same canonical `897327`).

### Body extractor — `agent/body_extractor.py`
Server-side parser for single-trade emails: pulls currency pair, UTI, trade date, buy/sell, notional, counterparty, value date from the subject + "Trade Details" block, normalized with the *same* coercers so a body trade and a spreadsheet trade compare apples-to-apples.

### Served to the UI
The **Extract Trade Data** register merges **attachment trades** (`/extract/trades`) and **body trades** (relevant cases with no spreadsheet), de-duplicated by trade ID (attachment preferred), with a **Source** column. On the demo data: **80 rows = 12 Body + 68 Attachment**, with the body IDs (`00047…00058`) and blotter IDs (`00001…00034`, `00067…00100`) non-overlapping.

---

## 9. Reconciliation — "Recon Compare & Match"

The 4th pipeline step (and the `/match/trades` endpoint). `agent/compare_match.py` → `GoldenSource` + `CompareMatcher`.

### What it does
For each extracted trade, keyed by `trade_id`:
1. **Match** against the **golden source** (`data/golden/FX_Options_Trade_masterDataset.xlsx`, a 100-row master blotter — stands in for GLOSS / OBI / FO systems), normalized with the same coercers as extraction.
2. **Enrich** — populate any field the email/attachment didn't carry from the golden record.
3. **Compare** — for the configured `match_fields` present on both sides, check agreement (numeric within tolerance, dates canonicalized, strings folded) → field-level diffs.
4. **Classify + score**:

| Status | Meaning |
|---|---|
| **MATCHED** | golden found, all compared fields agree, nothing to fill |
| **ENRICHED** | agree on present fields, ≥1 missing field populated |
| **NEAR_MATCH** | some compared fields disagree (confidence above the break threshold) |
| **BREAK** | compared fields disagree badly (confidence below threshold) |
| **UNMATCHED** | no golden record for that trade ID |

Configurable in `EmailAgentConfig`: `golden_source_path`/`_sheet`, `match_key`, `match_fields` (default the 6 economic fields: currency_pair, buy_sell, notional_amount, counterparty, settlement_date, strike_rate), `match_numeric_tolerance` (1%), `match_break_threshold` (0.6), `match_enrich_enabled`. **Never raises** — a missing golden file yields an empty source / UNMATCHED, not an exception.

On the demo data: **80 trades vs 100 golden records → 68 MATCHED, 12 BREAK, 179 fields filled.**

### ⚠️ Reconciliation vs the *true agentic* Compare & Match
What is built today is **reconciliation**: extracted-trade-vs-**one** golden source, filling gaps and flagging field-level breaks against that single source of truth. This is deterministic and correct, but it is **not yet the full agentic Compare & Match** the engagement ultimately wants. That target is **multi-source reasoning**: for one trade ID there will be multiple emails at different workflow stages (buyer, seller, exchange, amendments) plus supporting reports, and the break is when **two sources disagree with each other** — requiring human-like judgement to weigh the sources and decide the correct value. That capability (and per-trade multi-email handling) is on the roadmap (§16); the current step is named **"Recon Compare & Match"** to reflect this honestly.

---

## 10. Storage, Deduplication & the Phase-2 Handoff

Every **Relevant** email becomes a self-contained **case** on disk plus a row in a SQLite index.

```
data/processed/{trade_id}_{asset_class}_{YYYYMMDD}/
├── email_body.txt          raw body
├── email_metadata.json     sender, subject, received, source file, classification
├── manifest.json           the Phase-2 contract
├── attachments/<files>     every attachment, byte-for-byte
└── extracted_trades.json   normalized trade rows from the attachments
```

The folder date is the **processing date**. Emails with no extractable trade ID get a stable `UNKNOWN_<hash>` id and are **not** deduplicated (a blotter is a batch, not one trade).

**`manifest.json`** is the deliberate handoff contract: trade ID, asset class, message ID, subject, sender, paths, the attachment list (with per-attachment extraction status + counts), the classification block, the extraction summary, and `ready_for_extraction: true`.

**`data/email_index.db`** — a single `email_cases` table tracks every processed email; two idempotency guards (`message_id_exists`, `trade_id_exists`) and `INSERT OR IGNORE` make runs safe. Backs `/storage/cases`, `/storage/cases/{trade_id}`, `/storage/stats`.

> Roadmap note (§16): the index is currently one wide table; a **relational, per-product-class** schema is planned so a missing field reads as a genuine break rather than an ambiguous empty column. Idempotency should key on the **email's unique id** (Graph `id`), not the trade ID, since one trade ID spans many emails.

---

## 11. The Service Layer — Mock Graph & the Dev↔Prod Swap

In production the mailbox is **Microsoft 365 / Outlook** via the **Microsoft Graph API**. To build without a tenant, the project ships a **mock Graph service** (`mock_graph/`, port 8001) with **identical field names**:

- OAuth2 client-credentials token endpoint.
- Bearer-authenticated `/v1.0/users/{mailbox}/messages` with `$top`/`$skip` paging + `@odata.nextLink`, `$select`, `$expand`, and the `Prefer` body-type header.
- Attachments endpoint with base64 `contentBytes`.
- `eml_to_graph.py` parses the inbox `.eml` files into Graph-shaped records at startup.

`connectors/graph_connector.py` is the production-shaped connector (OAuth2 → paged fetch → per-message attachment fetch). Because mock and real Graph are field-identical and the connector output is identical for both sources, **going live is a config change** — point `GRAPH_BASE_URL` at real Graph with a tenant/client/secret. *(Real Graph access is currently a procurement blocker, not a code one.)*

---

## 12. The Agent API & Observability

`api/` is the agent's FastAPI service (port 8000). **Every module is an endpoint**, and **every response is the same envelope**, success or failure.

```json
{ "status": "success", "data": { … }, "error": { "code", "message" },
  "correlation_id": "…", "timestamp": "…Z" }
```

### Endpoints
| Method · Path | Purpose |
|---|---|
| `GET /health` | Liveness + configured source and Graph URL. |
| `POST /classifier/classify` | Classify a single `{subject, body}`. |
| `POST /connector/fetch` | Fetch all emails from `{source: local\|graph}`. |
| `POST /connector/preview` | Fetch one email's body by message ID. |
| `POST /agent/run` | Run the full pipeline from `{source}`; returns stats + classified list. |
| `GET /extract/trades` | Trades parsed from stored xlsx/csv attachments. |
| `GET /match/trades` | **Reconciliation** — extracted register matched + enriched + compared vs the golden source. |
| `GET /storage/cases` · `/cases/{trade_id}` · `/stats` | Stored cases + manifest + counts. |
| `GET /config` · `PUT /config` · `POST /config/reset` | Read / live-update / reset the tunable classifier config. |

### Two log streams
- **Developer log** (`utils/logger.py`) — human-readable, level-gated, UTF-8 safe for Windows.
- **Audit log** (`utils/audit.py`) — append-only JSON, one event per business action (`agent.run.*`, `email.classified`, `case.stored`, `case.restored`, `attachment.extracted`, `trades.matched`, `api.request`), `logs/audit_<date>.log`. Field set is a contract; production ships it to a WORM store / SIEM.

Both streams + every HTTP response carry a shared **correlation ID**.

---

## 13. The Frontend — Pipeline, Run Console, Configure Workflows

A single-page app (`frontend/`) that makes the pipeline tangible and gives operations a place to run and tune it.

### Stack
| Layer | Choice |
|---|---|
| Framework | **Next.js 14** (App Router) |
| UI | **React 18** + **Tailwind CSS** (PostCSS, autoprefixer) |
| Helpers | `clsx`, `date-fns`, inline SVG icons |
| State | **React Context + sessionStorage** (no Redux) |
| Backend link | `next.config.js` rewrite `/api/backend/*` → `:8000` |

*No TypeScript — plain JS/JSX by current choice.*

### Pages
- **Login** (`/login`) — branded placeholder auth.
- **FX Trade Settlement** (`/pipeline`) — the **four-step** pipeline (Sync → Classify → Extract Trade Data → Recon Compare & Match). The flagship screen. State persists across navigation + reload via Context + sessionStorage; results are cached per dataset.
- **Configure Workflows** (`/schedules`) — lists workflows with **Run · View · Edit · Delete**; stat cards (Total Workflows / Active / Inactive); edit keywords/fields/cadence (drives the live classifier).
- **Settings · Match Queue · Records** — labelled "coming soon" placeholders.

### The Run console (`components/pipeline/RunConsole.js`)
Clicking **Run** on a workflow opens a modal that executes the full pipeline **sequentially against the real backend** — Sync (`/connector/fetch`) → Classify (`/agent/run`) → Extract + Recon (`/match/trades`) — with an animated 4-stage stepper, a progress bar, and per-stage result lines (e.g. "29 emails · 2 with attachments", "68 matched · 12 breaks · 179 fields filled"). "View results" lands on the populated Recon Compare & Match tab. *(Save/Trigger states are real calls; the console is the "agent runs itself" UX.)*

---

## 14. The Visual Workflow Builder & Marketplace (showcase)

`components/workflow/WorkflowBuilder.js`, launched from **Configure Workflows → Edit / Add Workflow**. A full-screen, **n8n / Node-RED-style** drag-and-drop canvas that previews the "build-your-own agentic workflow / marketplace" vision.

> **Scope: this is a mock for showcasing — not contracted, not wired to the backend.** Save / Trigger are placeholders. It is hand-built (no React Flow / external diagram library) on the existing Next.js + Tailwind + inline-SVG stack.

### Block library (capability nodes)
**Email Ingestor · Golden Source · Triage Classifier · Trade Extractor · Compare & Match · Decision Router · Human Review · Output Action · Feedback Loop** — each colour-accented, with a per-block config side panel (e.g. Ingestor: source/mailbox/filter/store; Compare & Match: golden source/match fields/tolerance; Decision Router: field + operator + **multiple branches**; Human Review: assignee/role/subject; etc.).

### Interactions
- **Drag** blocks from the library onto the canvas; **drag** nodes to reposition (connectors follow flush).
- **Connect** by dragging from a node's output port to another node; **hover a line** to delete it. The **Decision Router** has one output port per branch (add/remove branches).
- **Click** a node to configure it (live-updates the node card).
- **Undo / redo** with `Ctrl+Z` / `Ctrl+X` (also a toolbar) — tracks moves, drops, connects, deletes, branch changes, and config edits.
- **Edit** mode seeds the FX pipeline (Email Ingestor → Triage Classifier → Trade Extractor → Compare & Match → Decision Router → {matched → Output Action · break/review → Human Review}); **Add Workflow** opens a blank canvas where new blocks start with no pre-filled details.

A companion **node catalog** (`docs/Workflow_Builder_Node_Catalog.xlsx`, generated by `tools/build_node_catalog.py`) documents the blocks, ports, configs, data contracts, and connection rules.

> Per stakeholder direction, the next step here is a **marketplace view** (capability cards with descriptions, configurable fields, predecessor rules, and an info tooltip) plus block gating (mandatory predecessors) and author/creator roles — rather than deeper free-canvas build.

---

## 15. What's Built vs Not Built

Honesty about scope is part of the deliverable.

### ✅ Built and working
- Email ingestion from a **local `.eml` inbox** and a **mock Microsoft Graph API** (OAuth2, paging, attachments) via a production-shaped `GraphConnector`.
- **Rule-based classification** (Relevant / Ambiguous / Irrelevant) with hard-negative early exit, trade-ID extraction, explainable reasons, confidence.
- **Deduplication** by message ID + trade ID; idempotent re-runs; self-healing case store.
- **Extraction** from **Excel/CSV** blotters (header detection, column mapping, source-agnostic normalization) **and** from single-trade **email bodies**, merged into one register with a **Source** column.
- **Reconciliation ("Recon Compare & Match")** against a mock golden source — match by trade ID, populate missing fields, compare with confidence + break statuses.
- **Structured case storage** (case folder + `manifest.json` + `extracted_trades.json`) — the Phase-2 contract.
- A full **FastAPI service** (every module an endpoint, uniform envelope, correlation IDs, developer + audit logging) including `/match/trades`.
- **Runtime-tunable configuration** via `/config`, driven from Configure Workflows.
- A **Next.js UI**: login, the 4-step pipeline, Configure Workflows, the **one-click Run console**, and the **visual Workflow Builder** (showcase).
- One-command **`launch.bat` / `stop.bat`**; **75 automated tests** passing.

### ⛔ Not built yet (and known gaps)
- **True agentic Compare & Match** — multi-source reconciliation (buyer vs seller vs exchange vs reports) with reasoning over disagreeing sources. Today's step is single-source **reconciliation** (§9).
- **Multiple emails per trade ID** — one trade ID across multiple workflow stages, with the latest driving the break (planned next; needs email-id keying).
- **HITL controls** — correcting a wrong/ambiguous classification, reviewing/overriding reconciled fields, retrying a failed email instance (planned next).
- **PDF / SSI (OCR)** — vector SSIs need render-to-image + OCR.
- **Live Microsoft Graph** — code is ready; real access is a procurement blocker.
- **Authentication & RBAC** — login is a placeholder.
- **Enterprise robustness** — incremental/idempotent batch keyed on email id, a **cron** inbox↔DB reconcile, failure/retry + run history, a **relational per-product-class** DB, and **cloud deployment** (stop demoing on localhost).
- **Marketplace view & roles**, **scheduler**, **Records/history UI**.

---

## 16. How We Proceed Further (Roadmap)

Value-ordered, reflecting the latest stakeholder direction.

### Tier 1 — Finish the core, close the loops (near-term)
1. **Flag breaks in the Extract tab** — show missing fields *before* reconciliation (main fields red, secondary fields amber) so extraction completeness is visible early.
2. **Multiple emails per trade ID** — expandable per-trade view keyed on the email's unique id (Graph `id`), differentiated by received date + workflow stage; latest drives the break.
3. **HITL** — classification override (esp. the ambiguous band), reconciled-field review/override, single-instance retry, all audit-logged.
4. **Marketplace view** — capability cards (description, configs, predecessor rules, info), block gating, author/creator roles.

### Tier 2 — Enterprise robustness
5. **Incremental, idempotent processing** keyed on email id; a **cron job** reconciling inbox (Graph) vs DB to pick up missed/new emails; **failure handling + retry + run history**.
6. **Relational DB** (a table per product class) so a missing field is a clear break.
7. **Cloud deployment** + real **Microsoft Graph** connection (config swap once access is granted).

### Tier 3 — The agentic leap & scale
8. **True agentic Compare & Match** — reason across multiple sources/stages for a trade ID to judge the correct value (the engagement's headline capability).
9. **LLM-assisted classification & extraction** (context-aware, per the BRD) — with the rule engine as the auditable backbone and the LLM adjudicating the ambiguous band.
10. **PDF/OCR**, durable managed store + Records UI, **observability at scale** (SIEM/WORM, dashboards).

> The architecture was built so these slot in without re-plumbing — the connector seam, the uniform config, the manifest contract, the reconciliation engine, and the audit log are already in place.

---

## 17. Running the System

**All backend commands run from inside `agentic-workflows/`.** Developed on CPython 3.13; targets 3.11+. Core batch pipeline is pure stdlib; the service layer + extractor + reconciliation need `requirements.txt` (FastAPI, Uvicorn, httpx, python-multipart, openpyxl, pytest).

### One command (recommended)
```
launch.bat
```
Starts **Mock Graph (:8001)**, **Agent API (:8000)**, **Frontend (:3000)** in their own windows, installs deps on first run, restores the sample attachment emails, and opens the browser. `stop.bat` frees the ports.

### Manually
```powershell
python -m uvicorn mock_graph.app:app --port 8001
$env:GRAPH_BASE_URL="http://localhost:8001"; python -m uvicorn api.app:app --port 8000
cd frontend; npm install; npm run dev          # http://localhost:3000

# Command-line (no UI):
python demo.py                                 # regenerate inbox, run, prove dedup
python main.py                                 # single run against the current inbox
python tools/check_compare_match.py            # print a reconciliation report
python tools/generate_test_emails.py --clean   # rebuild the synthetic inbox
```

### Configuration (environment-overridable)
| Variable | Purpose |
|---|---|
| `EMAIL_INBOX_PATH` · `EMAIL_PROCESSED_PATH` · `EMAIL_DB_PATH` · `EMAIL_LOG_DIR` · `EMAIL_AUDIT_LOG_DIR` · `EMAIL_CONFIG_PATH` | Pipeline paths. |
| `GOLDEN_SOURCE_PATH` · `GOLDEN_SOURCE_SHEET` | Reconciliation golden source. |
| `GRAPH_BASE_URL` · `GRAPH_TENANT_ID` · `GRAPH_CLIENT_ID` · `GRAPH_CLIENT_SECRET` · `GRAPH_MAILBOX` · `GRAPH_FOLDER` | Graph / mock-Graph. |
| `EMAIL_SOURCE` | Default source (`local` / `graph`). |

---

## 18. Testing & Quality

**75 automated tests**, all passing (`python -m pytest` from the project root):

| Suite | Tests | Covers |
|---|---|---|
| `test_api.py` | 11 | Full API surface end-to-end (classify, fetch, run, storage, self-heal) over real HTTP. |
| `test_config.py` | 12 | Runtime config: validation, live re-classification, persistence, reset. |
| `test_attachment_extractor.py` | 11 | Extractor unit logic: header detection, normalization, status paths. |
| `test_extract.py` | 11 | Extractor + `/extract/trades` (CSV/XLSX parity, PDF ignored, dedup). |
| `test_compare_match.py` | 14 | **Reconciliation** — golden loading, enrichment, matched/break/near/unmatched, tolerance, body parser, `/match/trades`. |
| `test_mock_graph_api.py` | 8 | Mock Graph response shape vs real Graph (paging, `$select`, attachments). |
| `test_graph_connector.py` | 4 | `GraphConnector` over a real HTTP round-trip to the mock. |
| `test_eml_to_graph.py` | 4 | `.eml` → Graph-record conversion. |

The harness redirects all write paths to a temp dir, regenerates the deterministic synthetic inbox once per session, points the golden source at the repo copy, and runs the **mock Graph as a real Uvicorn server** so the sync `GraphConnector` exercises true HTTP. Pipeline tests assert the known split and idempotency.

---

## 19. Project Structure

```
agentic-workflows/
├── agent/
│   ├── email_agent.py            EmailAgentRunner — the SPAR loop
│   ├── attachment_extractor.py   xlsx/csv blotter parsing + normalization
│   ├── body_extractor.py         single-trade body field parser (server-side)
│   └── compare_match.py          Reconciliation: GoldenSource + CompareMatcher
├── classifier/rule_classifier.py scoring, thresholds, trade-ID extraction
├── connectors/                   local_connector.py · graph_connector.py
├── storage/                      file_store.py · db_index.py (SQLite)
├── config/                       settings.py (EmailAgentConfig) · config_store.py
├── api/
│   ├── app.py                    FastAPI: middleware, exception handlers, routers
│   ├── deps.py · models.py
│   └── routers/                  classifier · connector · agent · extract · match · storage · config
├── mock_graph/                   app.py (mock Graph v1.0) · eml_to_graph.py
├── utils/                        logger.py (dev log) · audit.py (compliance log)
├── frontend/                     Next.js 14 (App Router, JS/JSX, Tailwind)
│   ├── app/                      login · pipeline · schedules · settings · match-queue · records
│   ├── components/
│   │   ├── pipeline/             StepSync · StepShortlist · StepExtract · StepMatch · RunConsole
│   │   ├── workflow/             WorkflowBuilder (visual canvas, showcase)
│   │   ├── layout/ · ui/         header/sidebar · UI kit
│   └── lib/                      api.js · pipelineContext.js
├── data/
│   ├── raw_emails/inbox/         the synthetic .eml inbox (+ blotters)
│   ├── sample_emails_with_attachments/   blotters restored by launch.bat
│   ├── golden/                   FX_Options_Trade_masterDataset.xlsx (reconciliation source)
│   ├── processed/                per-case folders · email_index.db
├── tools/
│   ├── generate_test_emails.py   synthetic inbox generator (stdlib only)
│   ├── build_node_catalog.py     → docs/Workflow_Builder_Node_Catalog.xlsx
│   └── check_compare_match.py    CLI reconciliation report
├── docs/Workflow_Builder_Node_Catalog.xlsx
├── tests/                        75 tests
├── demo.py · main.py             CLI entry points
├── launch.bat · stop.bat         one-command orchestration
├── requirements.txt · pytest.ini
└── README.md · SERVICES.md · DOCUMENTATION.md
```

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **FX / OTC** | Foreign Exchange / Over-the-counter derivatives. |
| **Settlement** | Exchanging payments/assets to complete a trade. |
| **SSI** | Standard Settlement Instructions — where/how to settle a trade. |
| **Blotter** | A tabular list of trades (an Excel/CSV attachment, one row per trade). |
| **Trade ID / Deal Reference** | A trade's unique identifier (e.g. `FXOPT-2026-00047`). |
| **UTI** | Unique Trade Identifier — a regulatory trade reference. |
| **Golden source** | The trusted record of truth a trade is reconciled against (here a mock master blotter; in prod GLOSS / OBI / FO systems). |
| **Reconciliation** | Matching an extracted trade to the golden source, filling gaps, flagging field-level breaks. The built "Recon Compare & Match" step. |
| **Break** | A discrepancy — a missing field, or two sources disagreeing on a value. |
| **Compare & Match (agentic)** | The future capability: reasoning across *multiple* sources/stages to judge the correct value (§9, §16). |
| **HITL** | Human-in-the-Loop — review / approve / override before an outbound action. |
| **Run console** | The one-click modal that runs the full pipeline end-to-end. |
| **Workflow Builder / Marketplace** | The drag-and-drop canvas of capability blocks (showcase, §14). |
| **SPAR** | Sense → Plan → Act → Reflect — the agent loop. |
| **Idempotent** | Re-running produces the same result without duplicating work. |
| **Envelope** | The uniform success/error JSON shape every API endpoint returns. |
| **Correlation ID** | A per-request ID threading one request across all logs and the response. |
| **Microsoft Graph** | Microsoft 365's API, used to read the Outlook mailbox. |
| **WORM** | Write-Once-Read-Many storage, for tamper-evident audit trails. |

---

*This document covers the system as built for the Phase 1 PoC, on synthetic data; it is not connected to production mailboxes or downstream settlement systems. Figures (29 emails → 14 relevant → 80-row register; 68 matched / 12 breaks / 179 fields filled; 75 tests) reflect the current demo dataset and will change as the inbox, rules, and requirements evolve. The Workflow Builder is a non-contracted showcase.*
