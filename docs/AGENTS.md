# Scheduled agents

Six agents. All times **Israel (IDT)**. US market hours in Israel time are
**16:30 → 23:00**.

> **These must run on the machine, not in the cloud.**
> Every agent below reads Chrome against a logged-in session. A cloud-run agent
> cannot reach it, and would silently fall back to web search — the exact
> failure this project exists to eliminate.
> Desktop app → Settings → Cowork → *"Run new tasks in the cloud"* **off**.

| Job | When | Where | Role |
|---|---|---|---|
| Morning Sync & Brief | 09:00 Mon–Fri | **local agent** | **Canonical sync.** Reads Colmex in Chrome. |
| Zone sweep | 01:10 & 16:45 Mon–Fri | GitHub Actions | Zones, coverage, wishlist. No browser. |
| Grade candidates | on demand | local agent | Judgment. |
| Weekly Review | Sat 09:00 | local agent | Compounding loop. |
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

### Morning Sync & Brief — 09:00 Mon–Fri

```
Open Chrome to the broker platform (already logged in) and read the account:
balance, equity, every open position (symbol, side, qty, entry, stop, target,
current mark), and all working orders.

If the platform cannot be read — not logged in, page will not load, session
expired — POST {"kind":"account_sync","degraded":true,"notes":"<why>"} and
STOP. Do not substitute prices from web search. Do not estimate.

Read the day's high and low for each open position and send them as
highSinceOpen / lowSinceOpen.

POST the account_sync payload to $APP_URL/api/ingest.

Then produce the brief:
- overnight gaps and futures direction
- any catalyst on a held or wishlisted name in the next 48h
- for each position: distance to stop, distance to target, whether the stop
  can now be moved to breakeven for free
- action items, as an action_items payload — the complete current list

Rules: verify every price against the platform. Never present a setup whose
gates failed as actionable. Never suggest placing an order for me — produce the
ticket and I place it.
```

### Grade candidates — on demand, or after the 16:45 sweep

```
Take the wishlist from `/api/state` — the sweep has already found the names
within 6% of a level and ranked them by distance, so this starts from a list
rather than building one.

Use the trade-setup-grader skill. Screen ZONE-FIRST, then filter by catalyst —
catalyst-first screening surfaces names that have already moved, which is
exactly when the R:R gate fails.

Levels already come from the sweep, so open a chart only to see what the
numbers cannot show — the shape of the approach, and whether the zone has
actually rejected. Prioritise the two with-trend quadrants (up_demand,
down_supply).

For every candidate, POST a `zone`. Then a `suggestion` ONLY if price is
already at the level — otherwise a `wishlist` entry with the trigger. The
server enforces this and will reject a suggestion whose entry is more than
2% from `currentPrice`.
Run every gate and veto returned by /api/state — not the copies in this
document — and populate gatesPassed,
gatesFailed and vetoesCleared honestly — a suggestion that fails a gate still
gets posted, it just gets posted as blocked.

Check any zone that price has moved through and POST it as tested_broken.

Take account state from the app, not from memory.
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
