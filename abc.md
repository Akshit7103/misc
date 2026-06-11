# ERA — Easebuzz Onboarding Voice Agent

An outbound voice agent that qualifies merchant-onboarding leads, built as:

```
Twilio Media Streams  <->  FastAPI bridge  <->  OpenAI Realtime API
                                  |
                                  +-- tools (function calls)
                                       |
        deterministic qualification engine + 49-category restricted check
                                       |
                                   SQLite (PCV + audit trail)
```

**Design principle:** the LLM only *captures* fields and runs the conversation.
Every *decision* — restricted-business match, P1/P2/P3 disposition, escalation
routing — runs as deterministic, unit-tested Python (`qualification.py`,
`restricted.py`) and is written to an audit log.

## Layout

| File | Role |
|------|------|
| `main.py` | FastAPI app: outbound call, TwiML, media-stream WS, dashboard |
| `realtime_bridge.py` | Twilio ⇄ OpenAI Realtime audio bridge + barge-in + tool calls |
| `prompt.py` | ERA system prompt (the call script) |
| `tools.py` | Function schemas + dispatch to the engine |
| `qualification.py` | Deterministic P1/P2/P3 decision tree |
| `restricted.py` | Audited restricted-business classifier (separate model, temp 0) |
| `restricted_categories.py` | The 49 categories (source of truth) |
| `documents.py` | Required-document lookup by entity type |
| `db.py` | Async SQLite persistence + audit |
| `models.py` | Typed PCV fields / enums |
| `tests/` | Qualification engine unit tests (no creds needed) |

## Run locally

```bash
pip install -r onboarding_bot/requirements.txt
cp onboarding_bot/.env.example onboarding_bot/.env   # then fill in keys

# 1) start the server (from the repo root, so the package imports resolve)
uvicorn onboarding_bot.main:app --host 0.0.0.0 --port 8000

# 2) expose it
ngrok http 8000
#    put the https URL into onboarding_bot/.env as PUBLIC_URL, restart uvicorn

# 3) place a test onboarding call
curl -X POST http://localhost:8000/calls/outbound \
     -H "Content-Type: application/json" \
     -d '{"phone":"+9198XXXXXXXX"}'
```

Watch results at `http://localhost:8000/` (dashboard) or `GET /api/calls`.

## Test (no phone / no keys required)

```bash
pytest onboarding_bot/tests -q          # qualification decision tree
```

## Notes / next steps

- **Realtime model & schema:** code targets the GA Realtime schema with
  `audio/pcmu` passthrough for Twilio Media Streams.
- **Restricted classifier** fails *safe*: on error or low confidence it sets
  `needs_review` so a human checks rather than silently passing a merchant.
- **Security (before non-POC):** enable `VALIDATE_TWILIO_SIGNATURE`, add auth to
  the dashboard/API, and move SQLite → Postgres.
- **Portability:** the engine + tools are transport-agnostic. To move onto Vapi
  later, point its custom-LLM/tools at these same endpoints — the brain doesn't
  change.
