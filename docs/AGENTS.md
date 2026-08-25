# Scheduled agents

Six agents. All times **Israel (IDT)**. US market hours in Israel time are
**16:30 → 23:00**.

> **Local means one of two different things, and they are worth telling apart.**
> Morning Sync is local because it reads **Chrome** against a logged-in Colmex
> session, which no cloud runner can reach. The grader is local because of
> **credentials**: `.agent-token` and `.env` are gitignored, so a cloud runner
> that clones the repo gets neither. Both would otherwise fall back to web
> search — the exact failure this project exists to eliminate.
>
> The grader itself needs no browser. `src/lib/zones.ts` replaced chart-reading
> with computed levels, and the 2026-08-25 run graded sixteen candidates
> without opening one. Move it to the cloud the moment secrets can be supplied
> there — a routine exists at claude.ai/code/routines, paused, waiting on that.

| Job | When | Where | Role |
|---|---|---|---|
| Morning Sync & Brief | **manual, on demand** | local agent | **Canonical sync.** Reads Colmex in Chrome. Deliberately unscheduled — Oron runs it when he has positions. |
| Zone sweep | 22:10 UTC + 13:45/14:45 UTC Mon–Fri | GitHub Actions | Zones, coverage, wishlist. No browser, no secrets problem — they live in GitHub Secrets. |
| Grade candidates | **17:30 IDT Mon–Fri** | local scheduled task | Judgment. Prompt lives in this file, not in the task. |
| Universe Refresh | weekly, Sunday | local scheduled task | Pine cannot read the TradingView Screener. |
| Weekly Review | Sat 09:00 | *not built* | Compounding loop. |
| Catalyst Calendar | Sun 18:00 | *not built* | Veto source. |

Only two of these need to be agents. Everything else is arithmetic over data
the app already holds, and arithmetic does not need a browser, a logged-in
session, or a machine that happens to be awake — see
`.github/workflows/zones.yml`.

The old **Screener & Zone Analyst** agent is retired. It failed 10 of its 12
runs, and on the runs that worked it produced levels transcribed by eye out
of a screenshot. `src/lib/zones.ts` is a port of the MTF indicator verified
against its own table, and the sweep runs it over every name in the universe.

**Why 09:00 is primary and 23:15 is the backup:** the previous US close is
final and unchanging, so fetching it in the morning loses nothing — and the
machine is certainly awake at 09:00, whereas at 23:15 it may be asleep.

---

## The write path

Every agent POSTs to `POST /api/ingest` with
`Authorization: Bearer $INGEST_TOKEN`. Payloads are discriminated by `kind` and
validated with zod; a malformed body returns 422 with the exact issues.

### `account_sync`

```json
{
  "kind": "account_sync",
  "agent": "morning_sync",
  "account": {
    "label": "COLH70142", "broker": "Colmex",
    "balance": 8031.71, "equity": 7796.33, "sizingBase": 8031.71,
    "source": "chrome_broker"
  },
  "positions": [{
    "symbol": "QQQ", "side": "long", "qty": 3,
    "entry": 690.98, "stop": 700.00, "target": 734.00,
    "mark": 731.07, "markSource": "chrome_broker", "markAt": "2026-08-17T06:05:00Z",
    "fee": 2.00,
    "highSinceOpen": 734.39, "lowSinceOpen": 688.10
  }],
  "orders": [],
  "degraded": false
}
```

`fee` is the commission already charged, sent as a **positive** number
(Colmex displays it negative). Without it the app's P/L is gross and will
not tie out to the platform's Net P/L column — and a number that almost
matches is the same failure as a price that almost matches.

Four behaviours worth knowing:

- **`mark: null` is a valid, correct answer.** If the platform could not be
  read for one symbol, send null. The UI renders `no mark` rather than a
  plausible lie, and no `price_marks` row is written.
- **`degraded: true` writes a run record and changes nothing else.** Machine
  asleep, Chrome logged out, session expired — send this instead of an empty
  position list, or the book gets wiped.
- **A position that disappears is treated as closed.** It is moved to
  `pending_review`, which blocks the dashboard until journalled. Send the full
  current position list every time; partial lists will close things that are
  still open.

- **Risk is computed three ways and they are not interchangeable.** The app
  derives `riskUsd` (capital lost if the stop fills, from entry — clamped to
  zero when the stop is past breakeven), `riskFromMark` (what equity drops by
  if the stop fills today) and `lockedGain` (profit guaranteed even if the
  stop fills). Agents should quote **risk-from-here** when ranking positions;
  entry-based risk misranks an aged book badly.

`highSinceOpen` / `lowSinceOpen` are the extreme prices seen since the last
sync. The server keeps the running extreme. **These are the only way MAE/MFE
can ever be known** — they cannot be recovered after the trade closes.

### `suggestion`

The `trade-setup-grader` verdict, structured. Emit one per candidate.

```json
{
  "kind": "suggestion",
  "symbol": "GOOGL", "side": "long",
  "grade": "A_minus", "quadrant": "up_demand",
  "catalystState": "drifted_in", "entryMechanic": "limit_zone_edge",
  "confluenceCount": 3, "zoneId": 12,
  "entry": 182.40, "stop": 176.90, "target": 198.00, "rr": 2.84,
  "currentPrice": 183.10,
  "sizeUsd": 1180, "shares": 6,
  "gatesPassed": ["rr_2to1", "stop_beyond_structure", "verified_marks_only"],
  "gatesFailed": [],
  "vetoesCleared": ["zone_must_reject", "fundamentals_are_a_veto"],
  "thesis": "…", "invalidation": "…",
  "expiresAt": "2026-08-22T20:00:00Z"
}
```

`gatesFailed` is returned in the response. **A suggestion with a non-empty
`gatesFailed` must not be presented as actionable** — show it as blocked, with
the failing gate named.

`currentPrice` is required and the server checks it. An entry more than 2%
away is rejected with `too_far_from_price`, because entry, stop, target and
R:R are hypothetical until price is there. The stages are not
interchangeable:

| Stage | Means | Carries |
|---|---|---|
| `zone` | a fact about the chart | levels |
| `wishlist` | a zone worth waiting for | a trigger, **no R:R** |
| `suggestion` | price has arrived | real entry, stop, target, R:R |
| trade | taken | fills |

The sweep creates wishlist rows automatically for anything within 6% of a
level, pointing at the nearest zone. A name only becomes a suggestion when
it is close enough for the numbers to mean something.

### `zone`

Upserts on `(symbol, timeframe, direction)`. Setting `status` to
`tested_broken` stamps `invalidatedAt` **and expires every open suggestion that
depended on that zone** — which is what should have happened to the ZS thesis
automatically.

### `action_items`

Send the complete current list every run. Matching on `(kind, symbol)`:

- already open → `timesRepeated += 1` and `costOfDelayUsd` recomputed against
  `markAtFirstRaise`
- not in the list any more → marked done

This is what makes "close NKE, ninth brief running, −$306 so far" a number on
a screen instead of a paragraph nobody acts on.

### `catalysts`, `run`

`catalysts` replaces all future-dated rows. `run` records an agent execution on
its own — use it when an agent does something that writes nothing else, so that
"did it run?" is always answerable.

---

## Agent prompts

### Morning Sync & Brief — MANUAL, on demand

**Deliberately unscheduled.** Oron runs this himself when he holds positions,
by pasting Colmex screenshots into the session. That is why `/api/state`
reports `markSource: "manual"` rather than `chrome_broker`, and why a stale
`asOf` is normal rather than a fault. Do not schedule it — a sync that runs on
a timer against a flat book writes nothing useful, and one that runs without
a screenshot has nothing to read.

```
Sync the account from the Colmex screenshots Oron has pasted, then brief him.

If no screenshot has been provided, ASK for one. Do not open a browser, do not
guess at the book, and do not carry forward numbers from an earlier run.

TRANSCRIBE, THEN VERIFY. Use COLMEX_PROMPT in src/lib/colmex.ts to transcribe,
then run checkRow() on every row. Colmex publishes redundant columns and they
are the whole point:

    Net P/L   = (current - open) x qty x direction - fee
    SL,value  = |open - stop| x qty

Any row that does not tie out within TOLERANCE (2 cents — Colmex truncates to
the cent, so an exact 31.345 prints as 31.34) is REPORTED, not posted. Ask for
a clearer screenshot instead of transcribing it twice and hoping.

POST account_sync to $APP_URL/api/ingest with source "manual". Send the FULL
current position list every time — a position that is absent is treated as
closed and moved to pending_review. `fee` is positive even though Colmex shows
it negative. `mark: null` is a valid answer for a row that cannot be read; a
plausible guess is not.

If the screenshots are unreadable or incomplete, POST
{"kind":"account_sync","degraded":true,"notes":"<why>"} and STOP.

Send highSinceOpen / lowSinceOpen for each open position — the server keeps the
running extreme, and this is the ONLY way MAE/MFE can ever be known. It cannot
be reconstructed after the trade closes.

Then produce the brief:
- overnight gaps and futures direction
- any catalyst on a held or wishlisted name in the next 48h
- for each position: distance to stop, distance to target, and whether the stop
  can now be moved to breakeven for free (freeStopMoves in /api/state)
- total risk-from-mark as a percentage of the sizing base
- action items, as an action_items payload — the COMPLETE current list

Rules: every price comes from the screenshot, never from web search. Never
present a setup whose gates failed as actionable. Never suggest placing an
order — produce the ticket and Oron places it.
```

### Universe Refresh — weekly, Sunday 18:00

Reads the saved TradingView screen, which Pine cannot do. Needs a logged-in
Chrome, so this one is genuinely local for browser reasons, not credential
reasons.

**The job that has never failed**, because reading the screener DOM does not
depend on the chart canvas rendering — which is what broke the retired
screener agent. Keep it that way: no charts, no prices, no analysis. A list.

```
Your only job is to answer: which symbols are on the saved screen today?
No charts. No zones. No grading. No prices. If you find yourself opening a
chart, you have misread this prompt.

=================== STEP 1 — READ THE SCREEN ===================
Open TradingView in Chrome (already logged in), open the Stock Screener, and
load the saved screen named "EMA 200".

Extract the full Symbol column FROM THE DOM — do not scroll-screenshot it.
Transcribing levels by eye is what killed the retired screener agent, and a
symbol list is no more forgiving. The list runs to about 100 rows and the row
count is shown in the panel header: compare your extracted count against it
and say so if they disagree.

If the saved screen will not load, STOP, post a degraded run, and say so. Do
not substitute a different screen or a remembered list. The universe is
Oron's, not yours.

Read tickers exactly as shown. Do not correct, expand or tidy a symbol that
looks odd — the sweep looks them up verbatim against massive.com, so a
"corrected" ticker is a name that silently returns no data.

=================== STEP 2 — GET THE CURRENT LIST ===================
GET $APP_URL/api/state and read `screenerCoverage` — every symbol the app
already knows. `removed` has to be a real diff, not an assumption.

=================== STEP 3 — POST THE REFRESH ===================
  { "kind":"universe",
    "screen":"EMA 200",
    "symbols":[ every symbol currently on the screen ],
    "removed":[ symbols in screenerCoverage that are NO LONGER on the
                screen — they drop out of the analysis queue ] }

New names arrive with `analyzedAt` null, which puts them at the FRONT of the
analysis queue. Names already known simply have their last-seen date
refreshed — appearing on the screen again is not the same as having been
looked at, so their analysed status is left alone.

=================== STEP 4 — RECORD ===================
  { "kind":"run", "agent":"universe_refresh", "status":"ok",
    "degraded":false,
    "notes":"99 on screen, 12 new, 4 dropped, 61 awaiting analysis" }

=================== STEP 5 — REPORT ===================
Short. Five lines at most:
  - how many symbols the screen returned, and whether that matched the
    header count
  - which names are NEW this week
  - which DROPPED OFF — itself information, since a name leaving the screen
    may be a name whose trend just changed
  - how many now await first analysis
  - anything that looked wrong about the list

FLAG ILLIQUID LISTINGS. If the screen returns OTC foreign secondaries
(tickers ending F or Y with tiny volume — DTEGF, SNEJF, ZIJMF, HNHPF, AXAHF,
NVZMY and similar), name them. They are usually unchartable and they consume
analysis slots that should go to tradeable names. Recommend an average-volume
floor and a primary-listing filter on the saved screen — but do NOT filter
them out here. The app should see what the screen actually says; changing the
screen is Oron's call.
```

**Do not hardcode the ingest token into a task prompt.** Read it from
`.agent-token` at the repo root. The earlier version of this task carried the
64-character token in plaintext, which put a database write credential into
every copy of the prompt and every screenshot of it.

### Grade candidates — weekdays 17:30 IDT, after the intraday sweep

**This section IS the scheduled task.** The task in the desktop app holds only
a pointer to it, so editing the prompt below changes what the next run does —
there is no second copy to keep in sync. Do not duplicate these instructions
into the task itself.

It runs locally because that is where the credentials are. `.agent-token` and
`.env` are both gitignored, so a cloud runner has no way to read them; one was
tried on 2026-08-25 and correctly refused to start. See "What runs, and where"
in CLAUDE.md.

```
Grade trade-setup candidates and persist the verdicts.

Repo: C:\Users\97250\Documents\Claude\Projects\tradingassistant
App:  https://project-alr3f.vercel.app

STEP 0 — CREDENTIALS
The ingest token is the 64-char value in `.agent-token` at the repo root.
`.env`'s INGEST_TOKEN is stale (11 chars) and is overwritten by `vercel env
pull` — always prefer the file. MASSIVE_API_KEY comes from `.env`.
If either is missing, STOP. Do not substitute a price from web search — that
failure is the reason this project exists. Report what is missing and post a
`run` with status "failed".

STEP 1 — LOAD STATE
GET /api/state. Check `asOf` and `lastRun` first; on 503 or a degraded last
run, say "account state unavailable" and stop. Morning Sync is run MANUALLY
and is deliberately unscheduled, so `markSource` may be "manual" and `asOf`
may be old — if positions are open and `asOf` is stale, say so plainly rather
than sizing silently against a book you cannot see.

STEP 2 — SHORTLIST, DO NOT GRADE EVERYTHING
From `wishlist`: |distancePct| <= 2 AND score >= 50 (WORTH_OPENING_A_CHART in
src/lib/rank.ts). Sort by score, take at most the top 6. Typically ~50 sit in
the band and ~15 clear the bar. `contested` cannot clear it by construction.

STEP 3 — VERIFY PRICES YOURSELF
Fetch bars via src/lib/massive.ts and confirm each candidate ties out against
the wishlist `distancePct`. Report any that do not instead of grading them.
Say whether the last bar is today's or the prior close. Compute 14-day ADR.

STEP 4 — GRADE
Use the trade-setup-grader skill. Screen ZONE-FIRST, then filter by catalyst —
catalyst-first screening surfaces names that have already moved, which is
exactly when the R:R gate fails. The decisive question is what drove price
INTO the zone: drifted in and unopposed (fade it) versus pushed in by a live
escalating catalyst (do not fade). Web search is for CATALYSTS ONLY, never
prices. Prioritise up_demand and down_supply.

Levels already come from the sweep, so a chart only adds the shape of the
approach and whether the zone actually rejected — both of which can be read
from the bars when no chart is available (where the close sits in the day's
range, and whether the zone edge was tagged and reversed).

Arithmetic that must hold:
  - Stop: beyond the zone's distal edge AND no tighter than 1x ADR. The raw
    zone box is usually too narrow — most candidates fail here.
  - Target: the nearest opposing zone. Only when NO opposing zone exists may
    an R-multiple target be used, and then solve for the NET ratio, not 2R.
  - Fees: $2.00 per order minimum, so $4.00 the round trip. Quote R:R net of
    it (see "The 2:1 gate is gross" in CLAUDE.md).
  - Dividends: check the ex-date, use dividendImpact() in src/lib/metrics.ts.
  - Sizing: 1% of sizingBase. If no concentration rule exists in the `rules`
    table, post shares: null and sizeUsd: null and say sizing is pending that
    decision. Do NOT invent a cap.

STEP 5 — PERSIST
POST each verdict as a `suggestion`, including ones that FAIL a gate — those
store as blocked with the failing gate named, which is what stops the next run
re-grading them. `currentPrice` is required and an entry more than 2% away is
rejected; a name that is not there yet gets a `wishlist` entry with the
trigger instead. Check any zone price has moved through and POST it as
tested_broken.

Run every gate and veto returned by /api/state — not the copies in this
document — and populate gatesPassed, gatesFailed and vetoesCleared honestly.
If a gate cannot be evaluated from available data, leave it out of BOTH arrays
and say so; never claim it passed.

expiresAt: the coming Friday 20:00 UTC, or earlier if a dated event
(ex-dividend, earnings) should force a re-grade sooner.

Finish with a `run` payload: how many were in the band, how many cleared the
bar, how many were graded, and the main rejection reason.

STEP 6 — REPORT
Short, answer first: which names are actionable, which are blocked and by
which gate. Every level is a number. "Nothing clears the bar today" is a real
and common result — manufacturing a candidate so the run has something to show
is the failure this system exists to prevent.

Take account state from the app, not from memory. Never suggest placing an
order — produce the ticket; Oron places it.
```

### Zone Proximity Watcher — every 2h, 17:00–23:00

```
For every open position and active wishlist entry, read the current price from
TradingView in Chrome and compute distance to the nearest active zone.

Telegram me when price is within 1% of a zone, and again on touch. One message
per symbol per crossing — do not repeat every run.

Also send highSinceOpen / lowSinceOpen for open positions so MAE/MFE keep
accruing.

If Chrome is unreachable, POST a degraded run and stop. Silence is a bug;
a wrong number is worse.
```

### Close Sync — 23:15 Mon–Fri

Same as Morning Sync, `"agent": "close_sync"`, brief omitted. Best-effort: if
the machine is asleep this simply does not run, and 09:00 catches it.

### Weekly Review — Sat 09:00

```
Read the app's reports. Produce:
- every trade closed this week with its R multiple
- win rate, profit factor, expectancy, avg R — with trade counts, and say
  plainly when a number is too thin to read
- P&L split by rule compliance, per rule
- total cost of delay on action items
- zone hit rate: how many zones tested held vs broke
- every lesson flagged recurring; if any has now been flagged three times,
  propose the gate or veto it should become, in the exact wording for the
  rules table
- one question the data raises about the trade-setup-grader skill's claims
```

### Catalyst Calendar — Sun 18:00

```
For every symbol in the book and the wishlist, find the next earnings date.
Add CPI, PPI, NFP and FOMC for the coming fortnight. POST as `catalysts`.

These drive two vetoes: no resting limit order through a binary event, and no
new position within 48h of earnings unless the earnings is the trade.
```

---

## The `trade-setup-grader` contract — done

Step 2 read an account memory file and step 9 wrote one, so the brain reasoned
from whatever a previous session happened to write down and its conclusions
evaporated with the session. Step 2 now GETs `/api/state`; step 9 reads:

```
### 9. Persist the verdict

POST the structured verdict to $APP_URL/api/ingest as a `suggestion` payload
(see docs/AGENTS.md), and any zone read off the chart as a `zone` payload.
Populate gatesPassed / gatesFailed / vetoesCleared from the active rules.

The prose analysis is for the human. The payload is what survives, and what
the Method report is computed from.
```

Everything else in the skill is unchanged — it owns judgment, the app owns
memory and arithmetic, and neither should do the other's job.
