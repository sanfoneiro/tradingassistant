# TradingAssistant

Account state, trade journal, and rule enforcement for Oron's swing book.
Next.js on Vercel, Postgres on Neon (Drizzle), market data from massive.com.

**The system reads and reasons. It never places, modifies, or closes an order.**
The most it produces is a copy-pasteable ticket.

---

## The rule everything else follows

No number enters this database without a **source**, a **timestamp**, and a way
to **check it**. Anything that cannot reach a trusted mark writes `NULL` and
says so.

This is not a style preference. Four consecutive sessions once acted on
search-scraped quotes that were wrong by $1–1.6, including a GDX quote of
$112.49 against a real $88.26. Every guardrail below traces back to that.

The corollary that matters most in practice: **a plausible wrong number is
worse than a missing one.** A missing number gets greyed out; a wrong one gets
traded.

### Verify, don't trust

Where a source publishes redundant columns, recompute them and reject rows that
do not tie out. This is used twice and both are load-bearing:

| Source | Invariants checked | Where |
|---|---|---|
| TradingView MTF indicator | `Dist% = (entry − price)/price`, `50% = (entry + SL)/2` | `src/db/verify-zones.ts` |
| Colmex terminal screenshot | `Net P/L = (current − open)×qty×dir − fee`, `SL,value = |open − stop|×qty` | `src/lib/colmex.ts` |

Colmex **truncates to the cent** (an exact 31.345 prints as 31.34), which is
why the tolerance is two cents rather than a rounding boundary.

---

## The funnel — the stages are not interchangeable

```
zone      a fact about the chart
wishlist  a level worth waiting for — a trigger, and NO R:R
idea      price has arrived, so entry/stop/target/R:R are real
trade     taken
```

`src/lib/funnel.ts` holds both thresholds. `/api/ingest` **rejects** a
suggestion whose entry is more than `TRIGGER_BAND_PCT` (2%) from
`currentPrice` — five percent away those numbers are a hypothesis, and the
Ideas page would file them under "Actionable, every gate passed".

`wishlist.triggeredAt` is stamped when a name enters the band and held while it
stays, so "at its level since Tuesday and still not graded" is answerable.

### The 2:1 gate is gross, and the account is small

Colmex charges a **$2.00 minimum per order** — `COMMISSION` is qty × $0.004 and
`MIN_FEE_ADJ_EQUITY` tops it up to the floor, so every order costs $2.00 and a
round trip costs $4.00 regardless of size. On a ~$7.6k base that is 5.2% of the
1% risk budget before anything moves.

Two consequences the arithmetic hides:

- **A gross-exactly-2R target can never be net 2:1 at any size.** Minimum
  shares for net 2:1 is `3F / (reward − 2·risk)`; when `reward = 2·risk` the
  denominator is zero. Solve for the net instead: `k = 2 + 3F/(s·risk)`.
- **There is a minimum viable size as well as a maximum.** AER's planned risk
  was $11.70 against a $4 round trip, so a textbook stop-out cost **−1.33R,
  not −1.0R**. When the fee floor exceeds a concentration cap, skip the trade.

Quote R:R net of the round trip whenever size is small, and say so.

**$4 before entry, $2 after — and mixing them is easy.** Colmex's "Open price"
is a **breakeven that already contains the entry commission**, not the fill.
So a candidate being graded has paid nothing yet and carries the full $4; an
OPEN position priced off `Open price` has half of it baked into the entry and
only the $2 exit remains. Charging $4 to a stored position counts the entry
fee twice — it turned SSB's real 1.84 net into a reported 1.57 on 2026-08-27,
in an action item and in my own arithmetic.

The check that catches it: reconstruct the raw fill (`breakeven − fee/qty`),
compute it both ways, and confirm they agree. They must, because net R:R is
the real economic outcome. Note that **gross** R:R is NOT convention-free —
SSB reads 2.59 from the raw fill and 2.17 from the breakeven. Net is 1.84
either way, which is the argument for net being the number that decides.

### Sizing is a gate, not an afterthought

`positionSize()` checks three limits together, because the case that matters
only appears when they interact. SONY, 2026-08-26: a $0.31 stop on a $23.68
share meant the 1% risk rule alone asked for 245 shares — $5,802, **76% of the
account** — to risk $76.

Capping that is obvious. What is not obvious is that **capping it changes the
R:R**, because commission is $2 an order whatever the size. Fewer shares carry
the same $4 against a smaller reward, so a trade that clears 2:1 at full size
can fall under it once cut to fit.

So the viable sizes are a **window**: at least `minShares` for the ratio to
survive the round trip, at most the concentration cap. **When the window is
empty the trade is not takeable** — which is a different answer from "take it
smaller", and an unsizeable setup should never be graded at all.

The cap is **15% of the sizing base, 20% for an A_plus and only when 15% will
not carry the trade**. Oron's numbers, chosen after research put the
professional range at 10–20%; 15% is also what falls out of a 1% risk rule
against a 6% portfolio-heat ceiling (six slots). Do not change it silently.

### Ranking is not grading

`src/lib/rank.ts` orders *which charts are worth opening*. It cannot grade:
what drove price into the zone and whether the zone actually rejected are the
grader's questions and are not knowable from stored structure; fundamentals are
a veto living outside the database entirely.

Two properties hold **by construction**, because both are claims the method
makes rather than knobs:

1. The worst with-trend setup outranks the best countertrend one.
2. No `contested` name can clear the bar at all.

Change a weight and re-check both — the tests assert them.

Every weight is a **hypothesis**. The Method report exists to falsify them. If
with-trend candidates do not out-earn countertrend ones once trades close, this
scoring was wrong. `scoreReasons` is stored so a later review can ask what a
number was claiming.

---

## The zone engine

`src/lib/zones.ts` is a verified port of Oron's MTF Supply & Demand Pine
indicator — detection is a three-bar imbalance, ~60 lines. Verified 4/4 against
the indicator's own table on RL (`npm run db:verify-zones RL 1W`).

Things that look like bugs and are not:

- **A wick through the distal edge does not break a zone.** Only a close.
- **The 50% midpoint recedes** as the proximal edge shrinks, so a shallow tag
  never "reaches 50%" however deep it looks on the original box.
- **`toWeekly` drops the forming week** unless the last bar is a Friday. A
  weekly zone breaks on a *close*, and a forming week's close is just today's —
  counting it let a Tuesday dip delete a level the week ended back above.
- **A trending name legitimately has zones on one side only.** Supply gets
  broken and deleted as price makes highs; demand accumulates below.

**Compare against the chart with ADJ OFF.** TradingView's ADJ back-adjusts for
dividends; this API adjusts for splits only. Unadjusted is also the better
convention here — a zone records where real orders rested.

### Zones leave two different ways

| Status | Meaning | Consequence |
|---|---|---|
| `tested_broken` | price closed through the distal edge | stamps `invalidatedAt`, increments `testCount`, **expires every open suggestion depending on it** |
| `expired` | no longer tracked — outside the cap, or symbol left the screen | nothing happened to the price, nothing downstream dies |

Conflating them would have the sweep quietly killing ideas every time it
narrowed its own attention. Rows are expired, never deleted: trades point at
zones by id, and the weekly review's "zones tested held vs broke" needs them.

Only breaks from the last 5 bars are reported — the engine is stateless and
replays the whole history each run, so an unwindowed report would re-expire the
same suggestions every sweep.

---

## What runs, and where

Two questions decide the substrate: **does it need the logged-in browser?** and
**does it need judgment?** Two noes means it should not be an agent.

| Job | When | Where |
|---|---|---|
| Zone sweep | 22:10 UTC (levels) + 13:45/14:45 UTC (distances) weekdays | GitHub Actions |
| Morning Sync | **manual, on demand** | local — Colmex has no API, and Oron runs it himself when he holds positions |
| Universe Refresh | weekly, Sunday | local — Pine cannot read the TradingView Screener |
| Grade candidates | **17:30 IDT weekdays** | local Routine — real judgment |
| Score signals | **manual** (`npm run signals:score`) | local — replays every suggestion, taken or not |

**"Local" covers two different reasons.** Morning Sync needs a logged-in
Chrome. The grader needs only credentials — `.agent-token` and `.env` are
gitignored, so a cloud runner that clones the repo gets neither, and a cloud
routine tried on 2026-08-25 correctly refused to start rather than guessing at
prices. The grader needs no browser at all: `zones.ts` replaced chart-reading
with computed levels, and that day's run graded sixteen candidates without
opening one. It moves to the cloud as soon as secrets can be supplied there.

**Every agent prompt lives in `docs/AGENTS.md`, not in the task.** Each task
holds a three-line pointer: read CLAUDE.md, find your section, follow it. Edit
the doc and the next run changes; there is no second copy to drift. The old
copies had already drifted — the Morning Sync prompt in the repo described an
agent that opens Chrome to read the broker, which it does not.

**All three live in Routines** (`claude.ai/code/routines`), not in Cowork's
Scheduled tasks. A cloud Routine also exists for the grader, **paused**: cloud
runs cannot reach `.agent-token` or `.env`, and a test on 2026-08-26 correctly
refused to start rather than falling back to web search. Un-pause it the day
secrets can be attached to the environment.

**Two intraday crons fire and one exits quietly.** Israel and the US change DST
on different dates, so a fixed UTC time drifts an hour twice a year.
`--after-open` asks the *New York* clock and skips if outside 09:45–11:00 ET.
Exactly one sweep runs, year-round, with no maintenance at the clock change.

The intraday pass **refreshes distances, not levels** — mid-session the daily
bar is still forming.

**It runs in Actions, not Vercel:** the free data tier is 5 requests/minute so
115 symbols takes ~23 minutes, and Vercel Hobby crons fire once a day with
hour-level precision.

The retired `screener` agent failed 10 of its 12 runs and transcribed levels by
eye. Do not resurrect it.

---

## Gotchas that cost real time

- **`.env`'s `INGEST_TOKEN` is stale (11 chars).** The real 64-char token is in
  `.agent-token`. Scripts must prefer the file; `.env` is generated by
  `vercel env pull` and will overwrite hand edits.
- **The `vercel` CLI is not authenticated** and `vercel login` is interactive.
- **Vercel deploys take ~2 minutes.** Probe for the new behaviour before
  concluding a change did not work — and make the probe distinguish old from
  new. A probe that both versions pass proves nothing.
- **Schema changes: `npm run db:migrate`**, not `db:push`. Migrations are
  idempotent SQL in `drizzle/`, applied in name order.
- **`_to_delete/` is excluded from tsconfig** and contains a stale nested repo.
- **`gh` is not installed**; GitHub API is unreachable from here.
- **In Bash heredocs, `\_` collapses to `_`** — which is LIKE's wildcard. A
  cleanup query once matched every symbol of two or more characters and was
  stopped only by a foreign key.

---

## Layout

```
src/lib/zones.ts       the engine — detection, maintenance, toWeekly, nearestZones
src/lib/rank.ts        structural ranking; NOT grading
src/lib/funnel.ts      the two band thresholds, in one place
src/lib/metrics.ts     R multiples, three risk figures, MAE/MFE, expectancy,
                       dividendImpact (a short PAYS it; a long does not),
                       positionSize (the sizing WINDOW), checkStopPlacement
                       (both halves of rule 8), freeStopMove (needs an ADR)
src/lib/replay.ts      replaying a signal against the bars that followed it
src/lib/action-items.ts  which open item an incoming one is talking about
src/lib/colmex.ts      screenshot parse + the arithmetic that verifies it
src/lib/massive.ts     market data, throttled, retries 429
src/db/sweep-zones.ts  the universe sweep (runs in CI)
src/db/score-signals.ts  scores every suggestion, taken or not
src/app/api/ingest     the only write path agents use
src/app/(app)/guide    how the system works, for the person trading with it
docs/AGENTS.md         payload contracts and agent prompts
```

Run `npm test` before committing. The tests are the specification —
`metrics.test.ts` checks every signed calculation in **both** directions,
because a long-only suite passes happily while shorts report a loss as a gain.

---

## What reaches the screen

**An action item is something to DO. If there is nothing to do, show nothing.**
An empty list is a valid and common morning.

Three things were removed on 2026-08-27 for failing this, and all three were
mine:

- *"Hold the stop, do NOT move it to breakeven"* — about a stop Oron was not
  moving. Telling someone not to do a thing they are not doing spends a slot
  meant for work.
- Two items stating a true fact and asking for a decision (*"decide on the
  158.77 target"*). That is homework. Name the change and the number, or do
  not raise it.
- A whole panel explaining why a stop move was **not** free. The fix for a bad
  recommendation is to stop making it, not to argue the refusal on screen.

The counter behind action items exists so *"close NKE, ninth brief running,
−$306 so far"* is a number rather than a paragraph nobody acts on. A list that
fills with observations is a list nobody reads, and then the counter measures
attention that was never being paid. Full contract in `docs/AGENTS.md`.

**`kind` is part of an action item's identity.** Two agents describing one
recommendation differently used to close the old row and open a new one:
SSB crossed three rows in twenty-six hours (move_stop → review → move_stop)
and each read "raised once". `src/lib/action-items.ts` now carries history
across a kind change when exactly one item is open for that symbol — and
refuses when two are, because "close it" and "move the stop" are different
instructions. `resolution` says WHY an item closed, since `done` could not
tell one Oron acted on from one silently retracted.

---

## Still open

- **10 trades await the three free-text review fields.** Fills, dates, stops,
  P/L and R are all verified against the Colmex *execution* export
  (`trades_…csv` — the *transactions* export is a cash ledger with no prices).
  What is left is `whatWorked` / `whatFailed` / `lesson`, which `/api/review`
  requires and which are Oron's to write. Do not fabricate them, and never
  `emotion`. **ZS and XOM first** — one is the entry-discipline lesson, the
  other the stop-discipline one.
- **Nothing enforces a rule while a position is OPEN.** Every gate is checked
  at entry and none afterwards. `time_stop_on_B` says a B-grade closes flat
  after 8–10 sessions; `holdSessions` exists as a column that nothing fills.
  SSB is a B opened 2026-08-25, so its time stop lands around 5–9 September and
  nothing will say so.
- **`cooldown_24h` cannot be evaluated.** `/api/state` exposes no recent
  stop-out history, yet the grader has been listing it in `gatesPassed` — a
  claimed pass with nothing behind it. Either expose closes or drop the rule.
- **Nothing verifies the grader's own gate claims.** `gatesPassed` is whatever
  the agent wrote. The app stores entry, stop, target and rr and could
  recompute them at ingest exactly as it does for Colmex rows. That is how
  CCDBF was posted claiming `rr_2to1` at 2.0 gross / 1.85 net.
- **`rMultiple` is permanently NULL for NKE, QQQ and NTRA.** All three were
  entered with no stop, so there is no initial risk to divide by. That is the
  honest record — do not backfill a stop to make the column populate.
- **MAE/MFE is not being captured at all.** The Colmex Positions panel shows no
  daily high or low, so the manual sync sends null. Recoverable from bars for a
  CLOSED trade, except on the entry day.
- **`catalysts` is empty and the Catalyst Calendar has never run**, so both
  event vetoes are resolved by per-name web search each run.
- **The signal scorer runs by hand** (`npm run signals:score`) and has no page.
  Nine outcomes so far — far too few to read. Wire it into the sweep, and build
  the report at forty or fifty, not before.
- **Treat every `rules.note` as a claim to re-derive.** Two were rewritten on
  2026-08-25 because they cited figures no trade supported, and one of the
  replacements had to be retracted the same session when a single omitted trade
  (NTRA, +$273) moved its bucket from −$347 to −$74.
- **The ingest token was pasted into a chat on 2026-08-26** and sits in
  plaintext inside an old Cowork task. Rotating it means four places: Vercel
  env, `.agent-token`, the GitHub Actions secret, and that task.
