-- Close-path correctness columns. Additive and nullable only: the previous
-- deployment ignores every one of these, so this is safe to apply before the
-- code that writes them ships.
--
--   positions.initial_stop    the stop as first seen, so R is measured against
--                             the risk actually taken rather than a trailed stop
--   trades.exit_provisional   last mark before the position vanished; prefills
--                             the review form. A mark is not a fill.
--   trades.mae_price          extreme prices while open, carried over at close.
--   trades.mfe_price          Unrecoverable afterwards — capture or lose.

ALTER TABLE positions ADD COLUMN IF NOT EXISTS initial_stop double precision;

ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_provisional double precision;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS mae_price double precision;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS mfe_price double precision;

-- Backfill initial_stop for rows that predate the column. The current stop is
-- the best available estimate for positions already open; it is exact for any
-- whose stop has never been moved.
UPDATE positions SET initial_stop = stop WHERE initial_stop IS NULL;
