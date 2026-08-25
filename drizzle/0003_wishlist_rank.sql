-- Structural rank on the wishlist. Additive and nullable; older code ignores it.
ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS quadrant quadrant;
ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS score double precision;
ALTER TABLE wishlist ADD COLUMN IF NOT EXISTS score_reasons jsonb DEFAULT '[]'::jsonb;
