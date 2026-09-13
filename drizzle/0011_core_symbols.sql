-- The focus list, which is NOT the screen.
--
-- `screener_coverage` means one thing and must keep meaning it: whatever the
-- saved "EMA 200" screen returned this week. That is a FILTER — symbols
-- arrive and leave as they pass or fail it — so a name cannot be added to it
-- by hand, and adding one would also corrupt the wide sample that exists to
-- test whether the method works at all.
--
-- A focus list is the opposite kind of thing: a small set of names chosen
-- deliberately and swept every day whether or not the filter happens to
-- return them. Both are wanted, for different jobs — narrow for trading,
-- wide for measurement — so they are separate tables rather than one table
-- with a flag, and neither can quietly become the other.
--
-- Coverage rows are still written ONLY for names the screen carries. A core
-- name the filter does not return produces zones and wishlist entries but no
-- coverage row, exactly as a --wide discovery does.

CREATE TABLE IF NOT EXISTS core_symbols (
  symbol    text PRIMARY KEY,
  added_at  timestamptz NOT NULL DEFAULT now(),
  -- Why this name is on the list, so a later review can argue with it rather
  -- than guess. Every entry on the first list names the numbers that put it
  -- there.
  note      text
);
