-- Shared handyman directory (docs/HANDYMAN.md). Listings are public to members, so the phone is
-- stored in the clear; city and category are stored title-cased by the API.
CREATE TABLE handymen (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  phone      text NOT NULL,
  city       text NOT NULL,
  category   text NOT NULL,
  added_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone, city, category)
);
CREATE INDEX handymen_city ON handymen (city, category);

CREATE TABLE handyman_reviews (
  handyman_id uuid NOT NULL REFERENCES handymen(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text        text NOT NULL DEFAULT '',
  author      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (handyman_id, user_id)
);
