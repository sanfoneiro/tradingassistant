-- Drop bars_symbol_d_idx.
--
-- PRIMARY KEY (symbol, d) already creates a unique btree on exactly those
-- columns in that order, so 0009's extra index was a second copy of it: no
-- query could prefer one over the other, and every insert maintained both.
-- On the filled table it was costing 33 MB against a 0.5 GB quota.
--
-- It also disagreed with schema.ts, which only ever declared the primary key
-- and bars_d_idx — so a future `drizzle-kit generate` would have produced a
-- drop for it anyway. Doing it here keeps the migrations as the record.

DROP INDEX IF EXISTS bars_symbol_d_idx;
