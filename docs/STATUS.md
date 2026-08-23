# Build status — 2026-08-17

Verified against the repo, not from memory. HEAD `5468b04` = `origin/main`, working
tree clean (the 35 "modified" files are CRLF noise only, zero real diffs).
App answers at https://project-alr3f.vercel.app → redirects to `/login`.

---

## Built and deployed

**App core — 8 commits, all pushed**

| Piece | Evidence |
|---|---|
| Schema | 16 tables, 11 enum vocabularies, 571 lines |
| `POST /api/ingest` | 652 lines, 9 payload kinds, zod discriminated union |
| `GET /api/state` | 197 lines, book + 3 risk figures + coverage, 503 on failure |
| `POST /api/review` | journal close-out |
| Metrics lib | 262 lines — three risk numbers, free stop moves, cost of delay |
| Auth | password + signed session cookie |
| Pages | Account · Ideas · Watchlist · Journal (+ detail & review form) · Reports · Rules |
| Seed | 13 mistake tags + 10 gates/vetoes, idempotent |
| Zone model | six MTF-indicator columns committed in `262bc77` — **is `db:push` run?** |

**Outside the repo**

- Morning Sync agent — working, took ~7 rounds, every fault found by running it
- TradingView server-side snapshot recipe — verified 2026-08-17, chart template finalised
- `chart-zones` skill — delivered as a `.skill` file

---

## Partial — written but never run

| Item | What's missing |
|---|---|
| `chart-zones` skill | install it, paste the ingest token in |
| Zone Check task prompt | never executed |
| Universe Refresh task prompt | never executed |
| `trade-setup-grader` step 9 | still says "update memory"; must POST the verdict |
| Reports page | renders, but no closed trades to compute from |

---

## Not built

1. **Zone Proximity Watcher** + Telegram — this is the alarm; nothing turns the
   wishlist into a notification today. Consider TradingView native alerts instead
   of polling: they fire immediately and need no rendering at all.
2. **Catalyst Calendar** — feeds the two event vetoes and the `regime` tag.
3. **Close Sync** — 23:15 redundancy.
4. **Weekly Review** — build last. There are no closed trades in the DB yet, so it
   has nothing to measure.

---

## Housekeeping found in the repo

- **`src/src/` is a duplicated tree** — a stale 2026-08-16 copy of the whole app
  extracted one level too deep, plus `src/package.json`, `src/tsconfig.json`,
  `src/docs/`, `src/next.config.ts`, `src/drizzle.config.ts`, `src/README.md`.
  All untracked, so the next `git add .` commits the mess. Delete it.
- **Prune the EMA-200 screen** — it carries unchartable OTC foreign secondaries
  (DTEGF, SNEJF, ZIJMF, HNHPF, AXAHF, NVZMY) that eat rotation slots. Add a volume
  floor and a primary-listing filter.
- **Backfill the ZS trade** — closed before the first sync, so the app has never
  seen the trade that produced half the mistake vocabulary.

---

## Suggested order

1. Delete `src/src/`, confirm `db:push` ran for the zone columns.
2. Install `chart-zones` + token. *(unblocks every chart-dependent agent)*
3. Run **Screener & Zone Analyst** live, end to end. Fix until it ties out.
4. Edit `trade-setup-grader` step 9 to POST. *(this is what fills the journal)*
5. Backfill ZS + prune the screen.
6. Zone Watcher (or TradingView alerts) → Catalyst Calendar → Close Sync.
7. Weekly Review, once ~10 trades have closed.

**Build one agent at a time and run it live.** Every fault in the Sync was found
by running it, never by writing it.
