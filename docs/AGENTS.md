# Scheduled agents

Six agents. All times **Israel (IDT)**. US market hours in Israel time are
**16:30 → 23:00**.

> **Local means one of two different things, and they are worth telling apart.**
> Morning Sync is local because Oron pastes **Colmex screenshots** into it by
> hand — Colmex has no API, and there is nothing to automate against. The grader is local because of
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
| Morning Sync & Brief | **manual, on demand** | local agent | **Canonical sync.** Reads pasted Colmex screenshots. Deliberately unscheduled — Oron runs it when he holds positions. |
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

**There is no automatic sync, by choice.** Colmex has no API, so the account
is read from screenshots Oron pastes when he holds positions. A flat book
needs no sync, and a timer cannot produce a screenshot.

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
sync, and the server keeps the running extreme. **These are the only way
MAE/MFE can ever be known for an OPEN position** — they cannot be recovered
afterwards.

In practice they are always null: the Colmex Positions panel does not show a
day's high or low, so the manual sync has nothing to send. MAE/MFE is
therefore not being captured at all today. For a CLOSED trade the window
high and low can be reconstructed from daily bars, except on the entry day
where the bar cannot say whether the extreme came before or after the fill —
so the loss is real but partial. Known gap; do not invent values to fill it.

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
SYNC — TradingAssistant. App: https://project-alr3f.vercel.app

Everything you need is in this prompt. Do not open the broker platform. Do not
fetch prices from the web. The attached Colmex PRO screenshot(s) are the ONLY
source of truth for account numbers.

The ingest token is the 64-char value in `.agent-token` at the repo root. Never
paste it into a prompt — an earlier version of this task carried it in
plaintext, which put a database write credential into every copy of it.

============ STEP 0 — CHECK FOR THE SCREENSHOT ============
Before anything else, check whether a Colmex screenshot is attached.

If NONE is attached, reply with exactly:
"Send me the Colmex screenshots — Positions panel and Working orders panel,
full window, headers visible. I'll wait."
and STOP. Do not transcribe, search, post, or use any tool. Wait for the images.

============ STEP 1 — TRANSCRIBE ============
HEADER:  ACCOUNT (COLH70142), PROJECTED BALANCE, BALANCE, WARN. MARGIN REQ.%
         Also the platform clock, bottom right ("08:43:59 (UTC+03:00)") — that
         is the capture time. Convert it to UTC for markAt.

POSITIONS: Symbol | Side | Quantity | Open price | Current price | Fee | Net P/L
         Use the FULL precision of Open price (it shows 8 decimals).
         FEE is shown negative ("-2.00 USD"); record the ABSOLUTE value. Every
         position has one; do not skip it. Without the fee the app's P/L is
         gross while the platform's is net, and the two will never tie out.

WORKING ORDERS: Symbol | Side | Type | Price | Stop price | Validity | Quantity
         "S/L for <id>" is the STOP  -> read the "Stop price" column.
         "T/P for <id>" is the TARGET -> read the "Price" column.
         Match to positions by symbol. A position with no S/L row has
         "stop": null. One with no T/P row has "target": null.

============ STEP 2 — TWO GATES ============
Both must pass before anything is sent. If either fails, STOP, say exactly
what failed, ask for a fresh screenshot, and POST nothing.

GATE 1 — COMPLETENESS. The tab labels state the expected counts:
  "Positions (N)" and "Working orders (M)". Count the rows you actually
  transcribed. If either is short, the panel was cut off — ask for it scrolled.

GATE 2 — ARITHMETIC. The screenshot contains redundant data, so the
  transcription can prove itself. Use checkRow() in src/lib/colmex.ts:

      long :  (current - open) x qty - fee
      short:  (open - current) x qty - fee

  Tolerance is toleranceFor(qty) = 0.01 x qty + 0.02, NOT a flat figure. The
  screen rounds prices to two decimals while the engine carries more, so a
  correctly-read row is already out by up to half a cent per share.

  Inside tolerance, the row is verified. Outside it, a digit was misread:
  STOP, name the symbol, show your computed value against the displayed one,
  and ask for a clearer screenshot. NEVER adjust a number to make the
  arithmetic work.

  Report the gate result in one line, e.g. "6/6 positions reconcile within
  tolerance; 11/11 orders read."

============ STEP 3 — POST THE SYNC ============
POST /api/ingest, kind "account_sync", agent "manual_sync".

  account: label COLH70142, broker Colmex,
           balance    = BALANCE from the header
           equity     = PROJECTED BALANCE
           sizingBase = balance (1% of this is the risk budget)
           source     = "manual"
  positions[]: symbol, side, qty, entry (full-precision Open price),
           stop (from the S/L row, else null), target (T/P row, else null),
           mark (Current price), markSource "manual",
           markAt (platform clock, in UTC), fee (POSITIVE, required),
           highSinceOpen: null, lowSinceOpen: null
  orders[]: { symbol, type: "stop" | "tp", level, qty, status: "working" }

  highSinceOpen / lowSinceOpen are NOT shown on this screen, so they stay
  null. That means MAE/MFE is not being captured for open positions and
  cannot be recovered afterwards. Known gap — do not invent values to fill it.

RULES FOR THIS PAYLOAD
- Send EVERY open position, every time. A position missing from the list is
  treated as closed and moved to pending_review.
- A number you could not read is null. Never estimate, never carry a value
  over from a previous run, never take one from the web.
- source and markSource are "manual" — these came from a human reading a
  screen, not an automated platform read. Label it honestly.

If no usable screenshot was attached, or it is unreadable, POST this and stop:
{ "kind":"account_sync", "agent":"manual_sync",
  "account":{"label":"COLH70142","balance":null,"equity":null,"source":null},
  "positions":[], "degraded":true, "notes":"<what was wrong>" }

============ STEP 4 — THE BRIEF ============
Report the POST result (positions written, marks written, anything moved to
pending_review), then:

BREAKEVEN DIRECTION — get this wrong and every sign flips.
  LONG : breakeven = entry. A stop BELOW entry is the LOSING side; move it UP.
  SHORT: breakeven = entry. A stop ABOVE entry is the LOSING side; move it DOWN.
  A short whose stop is above entry is NOT "already past breakeven" — it is
  the opposite. Check this explicitly for every short before writing a word.

RISK FROM HERE — the table that decides things.
    long: (mark - stop) x qty      short: (stop - mark) x qty
  Give the total in dollars and as % of sizingBase, and each position's share,
  ranked descending. This is deliberately NOT initial risk: on an aged book
  they diverge hard, and a position deep underwater with a nearby stop shows
  huge initial risk while having almost nothing left to lose.

LOCKED GAINS — any position whose stop is past breakeven cannot lose money.
  State the guaranteed profit. Say plainly it is a locked gain, not risk; its
  risk-from-here figure is giveback of open profit only.

FREE STOP MOVES — a position IN PROFIT whose stop is still on the losing side
  of entry. The value is the CAPITAL LOSS REMOVED. State it separately from
  giveback — the open profit still sitting beyond the new stop. Moving to
  breakeven removes the possible loss; it does not remove the giveback, so
  never write "risk -> $0". These cost nothing and are the highest
  value-per-effort action available.
  positionRisk() and freeStopMove() in src/lib/metrics.ts compute all three.

TARGETS — flag any sitting beyond a known supply/demand shelf, or that price
  has approached and failed more than once.

CATALYSTS — earnings or macro events on any held name within 48h.

OVERNIGHT — gaps and futures direction. This may come from the web; it is
  context, not a price that reaches the database.

RANKED ACTIONS — most valuable first, each with the dollar impact.

============ STEP 5 — POST ACTION ITEMS ============
kind "action_items", agent "manual_sync". Item kinds: close | move_stop |
adjust_tp | open | review. Each carries symbol, text, rationale, mark, qty.

Send the COMPLETE current list. Items you stop sending are marked resolved;
items repeated accrue their cost of delay automatically.

============ STANDING RULES ============
- Every account number comes from the screenshot. Nothing else.
- Never present a setup whose gates failed as actionable.
- Never place, modify or close an order. Produce the ticket; Oron executes.
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
