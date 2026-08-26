-- Why an action item stopped being open, which "done" could not say.
--
-- SSB, 2026-08-26. The same recommendation moved across three rows in
-- twenty-six hours because two agents described it with different `kind`
-- values: move_stop -> review -> move_stop. Each hop marked the previous row
-- "done" and started a fresh one, so timesRepeated read 1 every time and
-- firstRaisedAt reset to now.
--
-- Two separate faults. The cost-of-delay clock — the whole point of which is
-- to make "ninth brief running, -$306 so far" visible — could be zeroed by a
-- wording change. And a row marked "done" is indistinguishable from one Oron
-- actually acted on: item 13 said "move the stop to breakeven", which was
-- RETRACTED the next morning as wrong, and the record says it was done.
--
-- A plausible wrong record is worse than a missing one.
DO $$ BEGIN
  CREATE TYPE action_item_resolution AS ENUM (
    -- The agent stopped raising it. The nearest thing to "acted on" that can
    -- honestly be inferred, and still only an inference.
    'no_longer_raised',
    -- A same-symbol item of a different kind took it over. History carried.
    'superseded',
    -- Explicitly withdrawn because the advice itself was wrong.
    'retracted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE action_items
  ADD COLUMN IF NOT EXISTS resolution action_item_resolution;

-- Everything already closed was closed by the old path, which only knew one
-- reason. Label it honestly rather than guessing which were acted on.
UPDATE action_items
   SET resolution = 'no_longer_raised'
 WHERE status <> 'open' AND resolution IS NULL;
