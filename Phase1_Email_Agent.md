# Phase 1 — Email Agent
### Nomura SSG Agentic AI POC | FX & OTC Settlement

---

## Table of Contents
1. [Use Case](#1-use-case)
2. [Objective](#2-objective)
3. [Scope](#3-scope)
4. [Architecture Overview](#4-architecture-overview)
5. [Tech Stack](#5-tech-stack)
6. [Detailed Approach](#6-detailed-approach)
7. [Step-by-Step Development Plan](#7-step-by-step-development-plan)
8. [Folder & File Structure](#8-folder--file-structure)
9. [Data Models & Schemas](#9-data-models--schemas)
10. [Classification Logic — Deep Dive](#10-classification-logic--deep-dive)
11. [Attachment Handling — Deep Dive](#11-attachment-handling--deep-dive)
12. [Storage & Naming Convention](#12-storage--naming-convention)
13. [Logging & Observability](#13-logging--observability)
14. [Error Handling & Edge Cases](#14-error-handling--edge-cases)
15. [Testing Plan](#15-testing-plan)
16. [Handoff to Phase 2](#16-handoff-to-phase-2)

---

## 1. Use Case

Nomura's Middle Office (MO) and Back Office (BO) teams receive a high volume of emails related to FX Settlements — specifically **Alleges & DK (Don't Know)** and **SSI (Standard Settlement Instruction) Verification** workflows. These emails arrive in a shared/team mailbox, mixed with other non-relevant emails (meeting invites, work anniversaries, IT notifications, etc.).

Currently, analysts manually:
- Scan inbox to identify relevant FX settlement emails
- Open attachments (PDFs, Excel files, Word documents)
- Manually extract trade fields like Asset, Counterparty, Notional, Value Date, Rate
- Copy data into internal systems for further processing

**Volume:** ~300–400 emails per processing cycle, with **4 cycles every 3 hours** (~1,200–1,600 emails/day).

**The Email Agent automates:**
1. Reading emails from a local folder (synthetic drop zone during development)
2. Identifying which emails are relevant to FX settlement workflows using rule-based classification
3. Downloading and cataloguing email bodies and all attachments
4. Storing them in a structured local data lake for downstream extraction (Phase 2)

---

## 2. Objective

| # | Objective | Success Metric |
|---|-----------|----------------|
| 1 | Read emails from a local folder inbox | Agent reads all `.eml` files without manual intervention |
| 2 | Filter FX-settlement-relevant emails from inbox noise | Precision ≥ 95% on test set |
| 3 | Extract and store email body, metadata, and all attachments | 100% of attachments downloaded per relevant email |
| 4 | Deduplicate on Trade ID | No duplicate records in storage for same Trade ID |
| 5 | Pass structured output to Phase 2 (Extraction Agent) | Clean JSON manifest per email case |

---

## 3. Scope

### In Scope
- **Synthetic email generation** — programmatically create realistic FX settlement `.eml` files for development and testing
- **Local folder connector** — read `.eml` files from `data/raw_emails/inbox/` as the agent's inbox
- Email **classification** — relevant vs. not relevant to FX settlement using rule-based keyword and regex scoring only
- **Attachment extraction** — PDF, Excel (`.xlsx`), Word (`.docx`), plain text (`.txt`), inline images/screenshots
- **Structured storage** of raw email artifacts with standardised naming convention
- **JSON manifest** generation per case for handoff to Phase 2

### Out of Scope (Phase 1)
- LLM-based classification (deferred — will be added once rule-based baseline is validated)
- MS Graph API / Outlook live mailbox connectivity (deferred to production phase after Nomura IT access is granted)
- Parsing or understanding attachment content (→ Phase 2)
- Querying golden sources (→ Phase 3)
- HITL UI (→ Phase 4)
- ServiceNow integration (→ Phase 7)

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     EMAIL AGENT (Phase 1)                    │
│                                                             │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────┐  │
│  │  Local Inbox │───▶│  Rule-Based      │───▶│  Storage  │  │
│  │  Connector   │    │  Classifier      │    │  Layer    │  │
│  │              │    │                  │    │           │  │
│  │ - .eml files │    │ - Keywords       │    │ - Local   │  │
│  │   from disk  │    │ - Regex scoring  │    │   folder  │  │
│  └──────────────┘    └──────────────────┘    │ - SQLite  │  │
│         ▲                     │              │   index   │  │
│         │                     ▼              └───────────┘  │
│  ┌──────────────┐    ┌──────────────────┐            │      │
│  │  Synthetic   │    │  Attachment      │            │      │
│  │  Email       │    │  Extractor       │            │      │
│  │  Generator   │    │                 │            │      │
│  └──────────────┘    │ - PDF           │            │      │
│                      │ - Excel         │────────────┘      │
│                      │ - Word          │                    │
│                      │ - Images        │                    │
│                      └──────────────────┘                   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           JSON Manifest (output to Phase 2)          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Tech Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Language | Python 3.11+ | Core development |
| Email parsing | `email` (stdlib) | Parse `.eml` files |
| Synthetic email generation | `email.mime.*` (stdlib) | Programmatically generate test `.eml` files with attachments |
| Rule-based classification | Python `re`, keyword lists | Deterministic email filtering via keyword scoring and regex |
| PDF extraction | `pdfplumber` | Read PDF attachments (text + tables) |
| Excel extraction | `openpyxl` | Read `.xlsx` attachments (all sheets) |
| Word extraction | `python-docx` | Read `.docx` attachments |
| Image/screenshot OCR | `pytesseract` + `Pillow` | Extract text from inline images |
| Local storage | File system + `SQLite` (stdlib) | Data lake + deduplication index |
| Config management | `python-dotenv` | Environment variables |
| Logging | Python `logging` + `structlog` | Structured logs per run |
| Testing | `pytest` | Unit and integration tests |

---

## 6. Detailed Approach

### 6.1 Local Inbox + Synthetic Email Generation

**Why synthetic?**  
MS Graph API access to Nomura's Outlook mailbox requires IT approvals and OAuth2 credential setup, which is currently in progress. Rather than block development, we simulate the inbox using synthetic `.eml` files that closely replicate real FX settlement emails. When live mailbox access is granted, only the connector layer changes — the rest of the agent pipeline is identical.

**How the local inbox works:**  
The folder `data/raw_emails/inbox/` acts as the agent's drop zone. The agent reads every `.eml` file it finds, processes each one through the pipeline, and leaves the file in place (marked in SQLite as processed). On the next run, already-processed message IDs are skipped via the SQLite index.

**Synthetic email generator:**  
A standalone Python script (`tools/generate_test_emails.py`) creates `.eml` files programmatically using Python's stdlib `email.mime` modules — no third-party dependencies. The generator is configurable: number of emails, mix ratio (relevant / irrelevant / ambiguous), with or without attachments, partial vs complete trade data. Running the generator once populates the inbox so the full agent pipeline can be tested end-to-end immediately.

### 6.2 Email Classification Strategy — Rule-Based Only

A single-layer rule-based classifier handles all classification. There is no LLM call in Phase 1.

**How it works:**  
- Check email subject and body against keyword lists and regex patterns
- Assign a score based on signal strength of matches
- Hard-negative keywords (meeting invites, IT tickets, HR emails) trigger an immediate IRRELEVANT result if no asset keyword is also present
- Score thresholds determine the final label: RELEVANT, AMBIGUOUS, or IRRELEVANT

**AMBIGUOUS handling:**  
Emails that fall in the middle score range — where something settlement-adjacent was found but not clearly enough to confirm as FX trade-related — are labelled AMBIGUOUS and **skipped**. They are logged with their subject, score, and reason so they can be reviewed manually. This is the conservative choice: it is better to miss a borderline email than to misclassify noise as a trade case. LLM-based resolution of AMBIGUOUS emails will be added in a later iteration once the rule-based baseline is validated.

### 6.3 Attachment Extraction

For every email classified as RELEVANT:
- All MIME attachments are extracted from the `.eml` file
- Each attachment is identified by its file extension and MIME type
- The attachment is routed to the appropriate extractor (PDF / Excel / Word / text / image)
- The raw file is saved to disk under the case folder
- Extraction metadata (filename, size, MIME type, status) is logged in the SQLite index
- If extraction fails for a specific file, the error is logged and raw bytes are saved — processing continues for remaining attachments

### 6.4 Storage & Indexing

Each relevant email gets a dedicated case folder:
```
data/processed/{TradeID}_{AssetClass}_{YYYYMMDD}/
    email_body.txt
    email_metadata.json
    attachments/
        confirm_details.pdf
        settlement_instructions.xlsx
        counterparty_note.docx
    manifest.json          ← handoff file for Phase 2
```

A SQLite database (`email_index.db`) indexes all processed cases for deduplication and downstream lookup.

---

## 7. Step-by-Step Development Plan

### Step 1 — Project Setup & Environment

1. Create the project folder structure as defined in Section 8.
2. Create a Python 3.11 virtual environment (`venv`) and activate it.
3. Create `requirements.txt` with all dependencies listed at the end of this document and install via `pip install -r requirements.txt`.
4. Create a `.env` file at project root. Add only what is needed for Phase 1: no API keys are required since there are no LLM calls. Add `LOG_LEVEL=INFO` and any path overrides if needed.
5. Create `data/raw_emails/inbox/` and `data/processed/` folders — these are the agent's read and write zones.
6. Verify the environment by importing key packages (`pdfplumber`, `openpyxl`, `docx`, `pytesseract`) from a Python shell.

---

### Step 2 — Configuration (`config/settings.py`)

Build a single `EmailAgentConfig` dataclass that holds all tunable parameters in one place. This avoids hardcoded values scattered across modules.

**What the config must contain:**
- **Paths**: `inbox_path`, `processed_path`, `db_path` — all relative to project root
- **Subject keywords**: `allege`, `DK`, `don't know`, `settlement`, `confirm`, `SSI`, `FX`, `OTC`, `counterparty`, `notional`, `value date`, `forward`, `spot`, `fx options`
- **Asset-level keywords** (stronger signal): `FX settlement`, `FX options`, `OTC confirmation`, `FX spot`, `FX forward`
- **Negative keywords** (hard skip): `work anniversary`, `meeting invite`, `out of office`, `HR`, `IT ticket`, `password reset`, `lunch`
- **Classification thresholds**: `relevant_threshold` (default 0.7), `ambiguous_threshold` (default 0.3)
- **Attachment types supported**: `.pdf`, `.xlsx`, `.xls`, `.docx`, `.doc`, `.txt`, `.csv`, `.png`, `.jpg`, `.jpeg`

All values should have sensible defaults but be overridable. No API keys or external service config belongs here in Phase 1.

---

### Step 3 — Synthetic Email Generator (`tools/generate_test_emails.py`)

This is the primary development tool for Phase 1. It must be built **before** the agent so that testing can begin immediately.

**What it needs to produce:**
- Valid RFC 2822 `.eml` files that the `email` stdlib can parse
- Realistic FX settlement email content across multiple scenarios
- Optional binary attachments (dummy PDFs, Excel files)

**Categories of test emails to generate (minimum set):**

| Category | Count | Description |
|----------|-------|-------------|
| RELEVANT — complete | 5 | All 6 trade fields present in body or attachment; clear trade ID in subject |
| RELEVANT — partial | 3 | 2–3 fields missing; still clearly FX settlement related |
| RELEVANT — with attachments | 4 | Body light; real content in PDF or Excel attachment |
| AMBIGUOUS | 3 | Mentions "settlement" or "confirm" but unclear if FX trade-related |
| IRRELEVANT — noise | 5 | Meeting invites, IT notifications, HR emails |
| Duplicate | 2 | Same trade ID as an earlier RELEVANT email (to test dedup) |

**Email content guidelines for RELEVANT emails:**
- Subject format: `"FX Settlement Allege - Trade FX123456 - USD/JPY"` or `"DK Notice - OTC Trade OTC789012"`
- Body must mention counterparty name, a notional amount, a value date, and a rate
- Use realistic counterparty names: Barclays, Goldman Sachs, Deutsche Bank, JP Morgan
- Use realistic currency pairs: USD/JPY, EUR/USD, GBP/USD, USD/SGD
- Trade ID patterns: 2–4 uppercase letters + 6–8 digits (e.g., `FX123456`, `OTC789012`)

**Attachment generation:**
- For PDF attachments: create a minimal valid PDF using `fpdf2` library, or use a pre-made one-page dummy PDF
- For Excel attachments: create an `.xlsx` file using `openpyxl` with columns: Trade ID, Asset, CPTY, Notional, Value Date, Rate
- Save attachment bytes inline in the `.eml` using `MIMEBase` + base64 encoding

**Generator must be parameterised:**
- Configurable count per category
- Configurable output folder (defaults to `data/raw_emails/inbox/`)
- Deterministic message IDs so runs are reproducible
- `--clean` flag to wipe the inbox folder before generating

**Validation step after generation:**
- Run the generator, then manually open 2–3 `.eml` files in a text editor and verify subject, body, and attachment are present and readable before proceeding to the connector.

---

### Step 4 — Local Email Connector (`connectors/local_connector.py`)

This module reads all `.eml` files from the inbox folder and returns a unified list of email dictionaries.

**What it must do:**
1. Accept `inbox_path` as a parameter (from config).
2. List all `.eml` files in the folder using `pathlib.Path.iterdir()`.
3. For each `.eml` file, open it in binary mode and parse with Python's `email.message_from_bytes()`.
4. Extract and return a standardised dictionary per email with these fields:
   - `message_id` — from the `Message-ID` header; fall back to filename stem if absent
   - `subject` — from the `Subject` header
   - `sender` — from the `From` header
   - `received_at` — from the `Date` header
   - `body` — the `text/plain` MIME part (not an attachment)
   - `html_body` — the `text/html` MIME part if present
   - `attachments` — list of dicts, each with `filename`, `data` (bytes), `mime_type`
   - `source_file` — full path of the `.eml` file
5. Walk all MIME parts using `msg.walk()`. Distinguish body parts from attachments using `Content-Disposition` header and `get_filename()`.
6. Decode attachment bytes via `part.get_payload(decode=True)`.
7. Log how many emails were fetched (info level) and any parse failures (warning level).

**What it must NOT do:**
- Delete or move `.eml` files — leave that to the SQLite deduplication layer.
- Raise exceptions on a single bad file — catch per-file errors, log, and continue.

---

### Step 5 — Rule-Based Classifier (`classifier/rule_classifier.py`)

**What it must do:**

1. Accept `subject` (str) and `body` (str) as inputs. Return a tuple: `(label, confidence, reason)`.
2. Normalise both inputs to lowercase before any matching.
3. **Hard negative check**: if any negative keyword is found AND no asset-level keyword is found → return `IRRELEVANT` with high confidence (0.95). This is the fastest exit path.
4. **Scoring logic**:
   - Asset-level keyword hit in body or subject: +0.5 to score
   - Subject-level keyword hit: +0.3 to score
   - Trade ID pattern match (regex): +0.2 to score
5. **Threshold routing**:
   - score ≥ 0.7 → `RELEVANT`
   - score 0.3–0.69 → `AMBIGUOUS` (will be skipped and logged, not processed)
   - score < 0.3 → `IRRELEVANT`
6. Return a human-readable `reason` string listing which signals were found.

**Trade ID extraction** (separate method on the same class):
- Attempt 3 regex patterns in order:
  - Pattern 1: 2–4 uppercase letters followed by 6–12 digits (e.g., `FX123456`)
  - Pattern 2: `Trade ID:` / `Trade Ref:` followed by alphanumeric value
  - Pattern 3: standalone 8–12 digit number
- Search subject first, then first 1,000 chars of body
- Return the first match found, or `None` if nothing matches

---

### Step 6 — Attachment Extractor (`extractor/attachment_extractor.py`)

**What it must do:**

1. Accept `filename` (str), `data` (bytes), and `mime_type` (str). Return a dict with `text`, `status`, and `type`.
2. Determine file type from the extension (last part after `.` in filename). MIME type is used as a fallback if extension is absent.
3. Route to the appropriate extractor:

   **PDF** (`pdfplumber`):
   - Open bytes via `io.BytesIO`
   - Iterate over all pages
   - Extract raw text per page via `page.extract_text()`
   - Also attempt `page.extract_tables()` — for each table, join cells with ` | ` delimiter
   - Concatenate all pages into a single text string with page separators
   - Return `{text, pages, status: "success", type: "pdf"}`

   **Excel** (`openpyxl`):
   - Open bytes in data-only mode (resolves formula values)
   - Iterate over all worksheets
   - For each sheet, iterate rows via `iter_rows(values_only=True)`
   - Skip rows where all cells are empty
   - Join non-empty rows with ` | ` delimiter, prefix with `[Sheet: name]` header
   - Return `{text, sheets, status: "success", type: "excel"}`

   **Word** (`python-docx`):
   - Open bytes via `io.BytesIO`
   - Extract all paragraph text, filter empty paragraphs
   - Extract all tables: for each row, join cell text with ` | `
   - Return `{text, status: "success", type: "word"}`

   **Text / CSV**:
   - Direct UTF-8 decode with `errors="ignore"`
   - Return `{text, status: "success", type: "text"}`

   **Images** (`pytesseract` + `Pillow`):
   - Open bytes as PIL Image
   - Run `pytesseract.image_to_string(image)` for OCR
   - Return `{text, status: "success", type: "image_ocr"}`

4. Wrap each extractor call in try/except. On failure: return `{text: "", status: "error", error: str(e)}`. Never raise — let the agent continue with remaining attachments.

---

### Step 7 — Storage Layer

**File Store (`storage/file_store.py`):**

1. Accepts `base_path` as constructor argument. Creates the base directory on init.
2. `create_case_folder(trade_id, asset_class)`:
   - Format: `{trade_id}_{safe_asset_class}_{YYYYMMDD}` where safe means spaces → `_`, slashes → `-`
   - Date used is the **processing date** (today), not the email received date
   - Creates the folder and an `attachments/` subfolder inside it
   - Returns the `Path` object to the case folder
3. `save_email_body(case_dir, body_text)`: writes `email_body.txt` as UTF-8
4. `save_metadata(case_dir, metadata_dict)`: writes `email_metadata.json` as pretty-printed JSON
5. `save_attachment(case_dir, filename, data_bytes)`: writes raw bytes to `attachments/{filename}`, returns the saved path
6. `save_manifest(case_dir, manifest_dict)`: writes `manifest.json` as pretty-printed JSON with `default=str` to handle datetime serialisation

**DB Index (`storage/db_index.py`):**

1. Opens (or creates) a SQLite database at `db_path`.
2. Creates the `email_cases` table on first run (schema defined in Section 9).
3. `insert_case(record_dict)`: uses `INSERT OR IGNORE` so duplicate `message_id` values never raise an error.
4. `trade_id_exists(trade_id)`: returns bool — used by the agent to prevent creating duplicate case folders for the same trade.
5. `update_status(message_id, status)`: called by downstream phases to progress status from `ingested` → `extracted` → `matched`.

---

### Step 8 — Email Agent Runner (`agent/email_agent.py`)

The agent is a plain Python class — no orchestration framework. It implements the same **SPAR logic** (Sense → Plan → Act → Reflect) as a straightforward loop.

**Class: `EmailAgentRunner`**

Constructor accepts: `config`, `connector`, `classifier`, `extractor`, `store`, `db_index`.  
This makes each component injectable and independently testable.

**Method: `run()`**

This is the main entry point. It must:

1. **Sense** — call `connector.fetch_emails()` to get the full list of email dicts. Log the count.
2. **Plan + Act (loop)** — iterate over every email in the list:
   - Check if `message_id` already exists in SQLite — if yes, skip (already processed on a previous run)
   - Run the classifier on `subject` and `body`
   - If label is `IRRELEVANT`: log subject + reason, increment skip counter, continue
   - If label is `AMBIGUOUS`: log subject + score + reason to a dedicated ambiguous log, increment ambiguous counter, continue
   - If label is `RELEVANT`:
     - Check if `trade_id` already exists in SQLite — if yes, log duplicate and skip
     - Create case folder via FileStore
     - Save email body and metadata
     - Loop through all attachments: save each raw file to `attachments/`
     - Build the manifest dict (schema in Section 9)
     - Save manifest to case folder
     - Insert record into SQLite with `status: ingested`
     - Increment processed counter
3. **Reflect** — after the loop completes, log a run summary:
   - Total emails read
   - Processed (case folders created)
   - Skipped — irrelevant
   - Skipped — ambiguous (list their subjects so they can be reviewed)
   - Skipped — duplicate
   - Errors (attachment extraction failures)

**Why no framework:**  
This is a sequential loop over a flat list of emails. There are no parallel branches, no human checkpoints, no mid-run resumability requirements, and no multi-agent coordination. A plain class is easier to read, debug, and test.

---

### Step 9 — Entry Point (`main.py`)

The entry point ties everything together. It must:

1. Call `load_dotenv()` to populate environment variables from `.env`.
2. Instantiate `EmailAgentConfig` — all values sourced from env or defaults.
3. Instantiate each component: `LocalEmailConnector`, `RuleClassifier`, `AttachmentExtractor`, `FileStore`, `DBIndex`.
4. Instantiate `EmailAgentRunner` with all components injected.
5. Call `runner.run()`.
6. Print a run summary to stdout.

Optionally, wrap the `run()` call in a scheduler (`schedule` library or a simple `while True` + `time.sleep`) to run on a timed cycle matching Nomura's 3-hour processing cadence. For development, a single invocation on demand is sufficient.

---

## 8. Folder & File Structure

```
email_agent/
├── config/
│   └── settings.py              ← EmailAgentConfig dataclass
├── connectors/
│   └── local_connector.py       ← Read .eml files from local folder
├── classifier/
│   └── rule_classifier.py       ← Keyword/regex rule engine
├── extractor/
│   └── attachment_extractor.py  ← Route & extract all attachment types
├── storage/
│   ├── file_store.py            ← Write files to data lake
│   └── db_index.py              ← SQLite operations
├── agent/
│   └── email_agent.py           ← EmailAgentRunner (plain Python loop)
├── utils/
│   ├── logger.py                ← Structured logging setup
│   └── helpers.py               ← Utility functions
├── tools/
│   └── generate_test_emails.py  ← Synthetic email generator (dev tool)
├── tests/
│   ├── test_classifier.py
│   ├── test_extractor.py
│   └── test_agent.py
├── data/
│   ├── raw_emails/
│   │   └── inbox/               ← Drop zone for .eml files
│   └── processed/               ← Output data lake
│       └── {TradeID}_{AssetClass}_{YYYYMMDD}/
│           ├── email_body.txt
│           ├── email_metadata.json
│           ├── manifest.json
│           └── attachments/
├── .env                         ← Config overrides (no API keys needed in Phase 1)
├── requirements.txt
└── main.py
```

---

## 9. Data Models & Schemas

### Email Case Manifest (`manifest.json`)
```json
{
  "trade_id": "FX123456",
  "asset_class": "FX Settlement",
  "message_id": "<FX123456@test.local>",
  "subject": "Allege - FX123456 - USD/JPY - Value Date 2026-05-28",
  "sender": "counterparty@barclays.com",
  "received_at": "2026-05-26T09:14:22Z",
  "case_folder": "data/processed/FX123456_FX_Settlement_20260526",
  "email_body_path": "data/processed/FX123456_FX_Settlement_20260526/email_body.txt",
  "attachments": [
    {
      "filename": "confirm_FX123456.pdf",
      "path": "data/processed/FX123456_FX_Settlement_20260526/attachments/confirm_FX123456.pdf",
      "mime_type": "application/pdf",
      "size_bytes": 45320
    }
  ],
  "classification": {
    "label": "RELEVANT",
    "confidence": 0.90,
    "reason": "Asset keywords: FX Settlement; Subject keywords: allege; Trade ID pattern found: FX123456",
    "asset_class": "FX Settlement"
  },
  "ready_for_extraction": true
}
```

### SQLite `email_cases` Schema

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| message_id | TEXT UNIQUE | Email message ID — uniqueness enforced |
| trade_id | TEXT | Extracted trade identifier |
| asset_class | TEXT | FX Settlement / OTC Settlement / SSI Verification |
| subject | TEXT | Email subject line |
| sender | TEXT | Sender email address |
| received_at | TEXT | ISO datetime from email header |
| classification_label | TEXT | RELEVANT / IRRELEVANT / AMBIGUOUS |
| classification_confidence | REAL | 0.0 – 1.0 |
| case_folder | TEXT | Full path to case folder (null if skipped) |
| attachment_count | INTEGER | Number of attachments saved |
| processed_at | TEXT | ISO datetime when agent processed this email |
| status | TEXT | `ingested` → `extracted` → `matched` (updated by downstream phases) |

---

## 10. Classification Logic — Deep Dive

### Decision Tree

```
Email arrives
     │
     ▼
Negative keywords only? ──YES──► IRRELEVANT (skip + log)
     │NO
     ▼
Score asset/subject keywords + trade ID regex
     │
   score ≥ 0.7  ──► RELEVANT  → extract & store
   score 0.3–0.69 ► AMBIGUOUS → skip + log subject/score for manual review
   score < 0.3  ──► IRRELEVANT → skip + log
```

### Keyword Categories

| Category | Examples |
|----------|---------|
| Asset-level (strong, +0.5) | `FX settlement`, `FX options`, `OTC confirmation`, `SSI verification`, `FX spot`, `FX forward` |
| Subject-level (+0.3) | `allege`, `DK`, `don't know`, `confirm`, `settlement`, `counterparty`, `notional`, `value date` |
| Trade ID patterns (+0.2) | `FX123456` (letters+digits), `Trade ID: ABC-12345`, standalone 8–12 digit numbers |
| Negative (hard-skip) | `work anniversary`, `meeting invite`, `out of office`, `HR`, `IT ticket`, `password reset`, `lunch` |

### Notes on AMBIGUOUS

AMBIGUOUS emails are not processed but are not silently dropped either. The run summary lists every AMBIGUOUS email's subject, score, and matched keywords. This log serves two purposes:
1. Allows the team to manually review and decide if any should have been RELEVANT
2. Provides the training signal for when LLM classification is added — these are exactly the cases the LLM will be asked to resolve

---

## 11. Attachment Handling — Deep Dive

| File Type | Library | Extraction Method | Notes |
|-----------|---------|-------------------|-------|
| `.pdf` | `pdfplumber` | Text per page + `extract_tables()` | Tables joined with ` \| ` delimiter |
| `.xlsx` / `.xls` | `openpyxl` | All sheets, row-by-row | `data_only=True` resolves formula values |
| `.docx` / `.doc` | `python-docx` | Paragraphs + table rows | Empty paragraphs filtered out |
| `.txt` / `.csv` | stdlib | UTF-8 decode | `errors="ignore"` for non-UTF chars |
| `.png` / `.jpg` / `.jpeg` | `pytesseract` + `Pillow` | OCR on full image | Used for screenshots pasted into emails |

**Fallback behaviour:** if extraction fails for any file, the error is logged, raw bytes are saved to disk, and the manifest marks that attachment's `status` as `error`. Phase 2 will retry or flag it for manual review. Processing of the email case continues.

**Large file handling:** attachments exceeding 50 MB are saved to disk but not processed through the extractor. The manifest logs size and marks `status: skipped_large_file`.

---

## 12. Storage & Naming Convention

### Case Folder Name
```
{TradeID}_{AssetClass}_{YYYYMMDD}
```

Examples:
- `FX123456_FX_Settlement_20260526`
- `OTC789012_OTC_Settlement_20260526`
- `UNKNOWN_a1b2c3d4_FX_Settlement_20260526`

### Rules
- If a Trade ID is found in subject or body → use it directly
- If no Trade ID found → prefix with `UNKNOWN_` + first 8 characters of the `message_id` hash
- Asset class spaces are replaced with `_`, slashes with `-`
- Date used is the **processing date** (when the agent ran), not the email received date
- All folder names are lowercase-safe; no special characters other than `_` and `-`

---

## 13. Logging & Observability

Phase 1 uses Python's standard `logging` module with `structlog` for structured JSON-format output. No external observability platform is needed at this stage.

**Logger setup (`utils/logger.py`):**
- Configure `structlog` to output JSON lines per log event
- Each log event includes: `timestamp`, `level`, `module`, `message`, and any additional key-value fields
- Write logs to both stdout and a rotating file: `logs/email_agent_{date}.log`

**What to log at each stage:**

| Stage | Level | What to log |
|-------|-------|-------------|
| Connector fetch | INFO | Total `.eml` files found in inbox |
| Per-file parse failure | WARNING | Filename + error message |
| Classification — RELEVANT | INFO | Subject, trade ID, confidence score |
| Classification — IRRELEVANT | DEBUG | Subject + reason (verbose, can be muted) |
| Classification — AMBIGUOUS | WARNING | Subject, score, matched keywords — always visible |
| Duplicate skip | WARNING | Trade ID or message ID that was already in SQLite |
| Attachment extraction failure | ERROR | Filename + error + case folder path |
| Run summary (Reflect) | INFO | Processed / skipped / ambiguous / error counts |

**Run summary format (printed to stdout and logged):**
```
[Phase 1 Run Complete]
  Emails read:        22
  Processed:          12
  Skipped (irrelevant): 5
  Skipped (ambiguous):  3  ← subjects logged separately for review
  Skipped (duplicate):  1
  Attachment errors:    1
```

**When LLM classification is added later**, LangSmith will be introduced at that point to trace the LLM calls. There is no need for LangSmith in Phase 1.

---

## 14. Error Handling & Edge Cases

| Scenario | Handling |
|----------|----------|
| Duplicate Trade ID | Skip case folder creation, log warning, increment duplicate counter |
| Duplicate message ID | SQLite `INSERT OR IGNORE` silently skips; log as already-processed |
| Attachment unreadable / corrupt | Log error, save raw bytes, mark `status: error` in manifest — do not fail the whole case |
| Email with no attachments | Still store body + metadata; manifest lists empty `attachments: []` and `attachment_count: 0` |
| AMBIGUOUS email | Skip processing, log subject + score + keywords to ambiguous log for manual review |
| Very large attachment (> 50 MB) | Save raw to disk, skip extraction, mark `status: skipped_large_file` |
| Email with no body (body is blank) | Use subject only for classification; store blank `email_body.txt`; log warning |
| Email thread (reply chain) | `email.walk()` extracts all text parts from the full MIME structure |
| `.eml` file parse failure | Log warning with filename, skip that file, continue processing remaining files |

---

## 15. Testing Plan

### Unit Tests

```
tests/
├── test_classifier.py
│   ├── test_rule_relevant_email()         ← strong keyword match returns RELEVANT
│   ├── test_rule_irrelevant_email()       ← negative keyword returns IRRELEVANT
│   ├── test_rule_ambiguous_email()        ← partial match returns AMBIGUOUS
│   └── test_trade_id_extraction()         ← all 3 patterns (FX123456, Trade ID:, 8-digit)
│
├── test_extractor.py
│   ├── test_pdf_extraction()              ← real PDF bytes, check text returned
│   ├── test_excel_extraction()            ← real .xlsx bytes, check sheet content
│   ├── test_word_extraction()             ← real .docx bytes, check paragraph text
│   ├── test_image_ocr()                   ← real PNG bytes, check OCR output
│   └── test_corrupt_file_handling()       ← garbage bytes, verify error dict returned
│
└── test_agent.py
    ├── test_full_run_local_connector()    ← end-to-end: drop .eml, run agent, check manifest
    ├── test_deduplication()               ← same trade ID twice, only one case folder created
    ├── test_manifest_schema()             ← all required fields present in output manifest
    ├── test_irrelevant_email_skipped()    ← IRRELEVANT email produces no case folder
    └── test_ambiguous_email_logged()      ← AMBIGUOUS email produces no case folder but appears in log
```

### Synthetic Test Data via Generator

The test suite uses the synthetic email generator to produce a controlled, reproducible test set. Before running tests:
1. Run `python tools/generate_test_emails.py --count 22 --clean` to populate the inbox
2. Confirm the inbox folder contains the expected `.eml` files
3. Run `pytest tests/` from the project root

The generator produces a deterministic set so test results are consistent across runs and machines.

### Acceptance Criteria

| Metric | Target |
|--------|--------|
| Classification precision (RELEVANT) | ≥ 95% |
| Classification recall (no missed FX emails) | ≥ 98% |
| Attachment extraction success rate | ≥ 95% |
| Duplicate prevention (same Trade ID) | 100% |
| Manifest schema validity (all required fields) | 100% |
| AMBIGUOUS emails surfaced in log | 100% (none silently dropped) |

---

## 16. Handoff to Phase 2

Phase 1 outputs a `manifest.json` per case in the data lake. Phase 2 (Extraction Agent) reads these manifests as its entry point.

**Contract between Phase 1 and Phase 2:**

Phase 2 scans `data/processed/` recursively for all `manifest.json` files where `ready_for_extraction == true`. For each, it reads the manifest to locate the email body and all attachment paths, then begins field extraction.

**What Phase 2 receives per case:**
- `trade_id` — unique identifier for the trade
- `email_body_path` — path to raw email text file
- `attachments[]` — list of saved attachment paths, MIME types, and sizes
- `asset_class` — FX Settlement / OTC Settlement / SSI Verification
- `classification.confidence` — upstream rule-based confidence score
- `case_folder` — root folder for writing Phase 2 outputs back into the same case

**Status progression:**  
Once Phase 2 completes extraction for a case, it calls `db_index.update_status(message_id, "extracted")`. This marks the case as progressed and prevents Phase 1 from interfering with it on re-runs.

---

## Requirements

```
pdfplumber>=0.11.0
openpyxl>=3.1.0
python-docx>=1.1.0
pytesseract>=0.3.10
Pillow>=10.3.0
fpdf2>=2.7.0
python-dotenv>=1.0.0
structlog>=24.1.0
pytest>=8.2.0
pytest-mock>=3.14.0
```

---

*Document version: 1.3 | Phase: 1 — Email Agent | Project: Nomura SSG Agentic AI POC | Prepared by: Dev Team*
