-- Dividends crossing a holding period are real money and had nowhere to live.
--
-- A SHORT held through an ex-date PAYS the dividend: XOM cost $10.30 on ten
-- shares, which was 21% of that trade's loss and 69% of its entire planned
-- stop distance. Folding it into `fees` would have made the P/L right and the
-- label a lie, so it gets its own column.
--
-- Signed as the cash effect on the account: negative when paid (short),
-- positive when received (long). Additive and nullable; older code ignores it.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS dividend_usd double precision;
