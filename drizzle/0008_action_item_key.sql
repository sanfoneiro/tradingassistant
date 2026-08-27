-- A stable identity the AGENT supplies, so "same recommendation" stops being
-- a guess the server makes from a symbol.
--
-- Inferring it failed twice in two days. Matching on (symbol, kind) lost SSB's
-- history three times when two agents labelled one recommendation differently.
-- Falling back to symbol alone then MERGED two unrelated CBRE items — a target
-- concern and a concentration breach — because one open item per symbol is the
-- common case, not an edge.
--
-- Nullable: payloads without a key still work, and fall back to the heuristic
-- with a text-similarity gate in front of it.
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS key text;
CREATE INDEX IF NOT EXISTS action_items_key_idx ON action_items(key);
