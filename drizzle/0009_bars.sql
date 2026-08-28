-- Daily bars, stored.
--
-- The universe has been ~115 names because of the data plan's five requests
-- a minute: one call per symbol meant 115 symbols took 23 minutes, so the
-- TradingView screen was never the right universe, it was the affordable one.
-- One grouped-daily call returns every US ticker for a session — 12,485 of
-- them — so the constraint moves from bandwidth to storage, and storage is
-- cheap enough to hold roughly 1,800 tradeable names.
--
-- `d` is the SESSION date in New York terms, not a timestamp. Grouped daily
-- stamps its bars at 20:00 UTC (16:00 ET, the close) while the per-ticker
-- endpoint stamps the same bar at midnight ET — every OHLCV field ties out
-- exactly and only `t` disagrees, by sixteen hours. Storing a date rather
-- than either stamp is what stops that difference from ever mattering.

CREATE TABLE IF NOT EXISTS bars (
  symbol      text    NOT NULL,
  d           date    NOT NULL,
  o           double precision NOT NULL,
  h           double precision NOT NULL,
  l           double precision NOT NULL,
  c           double precision NOT NULL,
  v           double precision,
  PRIMARY KEY (symbol, d)
);

-- The sweep reads one symbol's whole history in date order; the universe
-- filter reads one session across every symbol. One index each.
CREATE INDEX IF NOT EXISTS bars_symbol_d_idx ON bars (symbol, d);
CREATE INDEX IF NOT EXISTS bars_d_idx ON bars (d);

-- The first cut of this migration used `numeric`, which disagreed with
-- schema.ts (doublePrecision) and stores wider. Fixed in place so an already
-- created table converges rather than staying silently different.
ALTER TABLE bars
  ALTER COLUMN o TYPE double precision,
  ALTER COLUMN h TYPE double precision,
  ALTER COLUMN l TYPE double precision,
  ALTER COLUMN c TYPE double precision,
  ALTER COLUMN v TYPE double precision;
