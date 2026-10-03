-- Which trading session a wishlist distance was measured against.
--
-- `distance_pct` has always been a number with no date on it. On 2026-10-03
-- every row the sweep had refreshed overnight tied exactly to THURSDAY's
-- close, not Friday's — the sweep ran before the plan served Friday's bar —
-- and nothing in the row could say so. The grader banded on those numbers
-- and had to rebuild the shortlist by hand.
--
-- A DATE, not a timestamp, for the same reason `bars.d` is one: a session is
-- a day, and the 16-hour stamp difference between Massive's two endpoints is
-- then unrepresentable rather than merely handled.
--
-- NULL means the writer did not say. That is honest and must stay possible:
-- an agent posting a wishlist row by hand does not know which close its
-- distance came from, and a guessed date would be worse than none.

ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS priced_session date;
