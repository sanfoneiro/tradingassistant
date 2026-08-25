-- What happened to every signal, including the ones never taken.
--
-- A trade needs six judgment fields only Oron can write. A signal needs none:
-- did price reach the entry, and then did it reach the target or the stop
-- first. Both are facts about the tape, so every idea can be scored — the
-- blocked ones especially, since a veto that blocks winners is the only thing
-- nothing in this system can currently detect.
--
-- Separate from `suggestions` on purpose. The suggestion is the claim; this is
-- the measurement. Recomputing a measurement must never edit the claim, and a
-- longer window later must not overwrite what an earlier one found.
DO $$ BEGIN
  CREATE TYPE signal_resolution AS ENUM (
    'never_triggered',
    'hit_target',
    'hit_stop',
    'ambiguous',
    'gapped_through',
    'unresolved',
    'bad_input'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS signal_outcomes (
  id serial PRIMARY KEY,
  suggestion_id integer NOT NULL UNIQUE REFERENCES suggestions(id) ON DELETE CASCADE,
  resolution signal_resolution NOT NULL,

  entry_price double precision,
  exit_price double precision,
  triggered_at timestamptz,
  resolved_at timestamptz,
  bars_to_trigger integer,
  bars_held integer,

  r_gross double precision,
  r_net double precision,
  /** SPY over the same holding period, in percent. Without it a book that is
   *  93% long in a rising tape looks like skill. */
  benchmark_pct double precision,

  /** The signal's own day already traded through its entry. Suggestions are
   *  written mid-session, so whether it filled before or after depends on an
   *  intraday sequence a daily bar cannot show. Excluded from headline stats
   *  rather than guessed — 17 of 25 brief recommendations tripped this, which
   *  is what made that backtest unusable. */
  same_day_touch boolean NOT NULL DEFAULT false,

  /** How far the window ran, so a later recomputation is comparable. */
  trigger_window integer,
  resolve_window integer,

  note text,
  computed_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_outcomes_resolution_idx ON signal_outcomes(resolution);
