-- When a wishlist entry first came inside the trigger band. Additive and
-- nullable; the previous deployment ignores it.
ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS triggered_at timestamptz;
