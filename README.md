# TradingAssistant

Account state, trade journal, and rule enforcement in one place — replacing the
daily Google Doc brief.

**The system reads and reasons. It never places, modifies, or closes an order.**
The most it produces is a copy-pasteable order ticket.

---

## The one rule everything else follows

No number enters this database without a **source**, a **timestamp**, and a
**confidence**. An agent that cannot reach a trusted mark writes `NULL` and says
so — it never guesses. Stale marks render amber, missing marks render as
`no mark` in red, and a degraded agent run is recorded in `runs` so a skipped
sync is loud rather than silent.

This exists because four consecutive sessions acted on search-scraped quotes
that were wrong by $1–1.6, including a GDX quote of $112.49 against a real
$88.26.

---

## Setup

### 1. Database

Vercel dashboard → **Storage → Neon** → attach to this project. That sets
`DATABASE_URL` automatically. The free tier is ~0.5 GB and scales to zero;
at a few hundred rows a day you will not outgrow it.

### 2. Environment

Copy `.env.example` to `.env` locally, and set the same keys in Vercel →
Settings → Environment Variables:

| Key | What |
|---|---|
| `DATABASE_URL` | set by the Neon integration |
| `INGEST_TOKEN` | bearer token the scheduled agents send. `openssl rand -hex 32` |
| `APP_PASSWORD` | passphrase for the UI |
| `SESSION_SECRET` | signs the session cookie. `openssl rand -hex 32` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional, for zone-proximity alerts |

Generate the two secrets yourself and paste them straight into Vercel — they
should not travel through chat.

### 3. Schema and vocabulary

```bash
npm install
npm run db:push     # create the tables
npm run db:seed     # 13 mistake tags + 10 rules
npm run dev
```

`db:seed` is idempotent — safe to re-run.

---

## What is where

```
src/db/schema.ts        every table; the comments explain why each field exists
src/db/seed.ts          the mistake vocabulary and the rule set
src/lib/metrics.ts      R multiples, MAE/MFE, expectancy, profit factor
src/lib/ingest-schema.ts the contract with the scheduled agents (zod)
src/app/api/ingest      the only write path agents use
src/app/(app)/          Account, Journal, Reports, Rules — all auth-gated
docs/AGENTS.md          prompts and payloads for the six scheduled agents
```

---

## Journal design

Tags are **enums, never free text**. Notes are free text. Mixing the two is how
a journal's analytics rot inside a month.

Four tag groups are emitted automatically by the `trade-setup-grader` skill at
entry — `quadrant`, `grade`, `catalyst_state`, `entry_mechanic` — so the
dataset is complete rather than sporadic. Only the review groups need a human.

**A closed trade blocks the dashboard until it is reviewed.** The review is six
fields and takes under a minute:

1. exit reason 2. execution 3. mistakes (zero or more)
4. what worked 5. what failed 6. the lesson + `recurring`

A lesson flagged `recurring` three times gets surfaced for promotion into a
rule. That is how the rule set grows from experience rather than from
resolutions.

### MAE / MFE

Max adverse and max favourable excursion, in R, captured **while the trade is
open** by the sync agents — they cannot be reconstructed from entry and exit
afterwards. MFE tells you what the market actually offered (the QQQ take-profit
sat $2 beyond it, twice). MAE tells you whether the stop is inside the noise
band.

---

## Reading the reports honestly

Every statistic shows its trade count, and any bucket under 5 trades is greyed
out. Most of these reports are noise before 30–50 closed trades. Build the
history first; read it later.

The **Method report** is the one nothing off-the-shelf can produce, because
nothing else knows the quadrant model. It is also where the skill gets
corrected: if the strong quadrants are not out-earning the weak ones, that was
a hypothesis, not a fact.
