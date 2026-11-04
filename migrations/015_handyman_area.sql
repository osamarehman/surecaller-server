-- Optional service area inside a city ("Gulshan-e-Iqbal, DHA"), shown on the listing.
ALTER TABLE handymen ADD COLUMN area text NOT NULL DEFAULT '';
