# Handyman directory

A shared, public-to-members list of local workers (electricians, plumbers, and any custom trade),
filtered by city then category, with 1–5 star ratings and written reviews.

## Data

- **Handyman**: `id`, `name`, `phone` (E.164), `city`, `category`, `area` (service area inside the city, or null), `rating` (average, 1 decimal,
  null when unrated), `ratingCount`, `createdAt`. One listing per phone + city + category, so the
  same plumber added twice merges into one card.
- **Review**: `rating` (1–5), `text` (0–500 chars), `author` (the name the reviewer chose, or
  `null` for Anonymous), `createdAt`, `mine` (true on the caller's own review). One review per member
  per handyman: posting again replaces it. Member ids never leave the server.
- City is free text: 2–40 characters, starting with a letter (letters, spaces, `.`, `'`, `-`). The 33
  suggested cities (`CITIES` in `src/routes/handymen.ts`, the same list as the app) keep their spelling;
  any other city is title-cased like a category and shows up in `/v1/handymen/cities` once listed.
  Matching ignores case and extra spaces.
- Area is optional free text (up to 80 characters, spaces collapsed), the part of the city the
  handyman covers ("Gulshan-e-Iqbal, DHA"). Adding a listing that merges into an existing one only
  sets the area when the listing had none.
- Category is free text, trimmed and title-cased ("solar fitter" → "Solar Fitter"). Built-in
  categories always keep their own spelling ("ac technician" or "AC Technician" → "AC Technician"). The app suggests the built-in categories: Electrician,
  Plumber, Carpenter, Painter, AC Technician, Mechanic, Mason, Welder, Cleaner. A user may type any
  other category; it shows up for everyone in that city once one listing uses it.
- A number on the opt-out list (`/opt-out`) can't be listed.

## Endpoints (all need the usual `Authorization: Bearer <token>`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/v1/handymen/cities` | | `{ cities: [{ name, count }] }` most listings first |
| GET | `/v1/handymen/categories` | `?city=Lahore` (optional) | `{ categories: [{ name, count }] }` for that city, or across all cities |
| GET | `/v1/handymen` | `?city=Lahore&category=Plumber` (city optional: no city = all cities; category optional, repeatable) `&sort=rating\|new` | `{ handymen: [Handyman] }`, max 200 |
| POST | `/v1/handymen` | `{ name, phone, city, category, area? }` | `Handyman` (201 new, 200 when it merged into an existing listing) |
| GET | `/v1/handymen/:id` | | `{ handyman: Handyman, reviews: [Review] }` newest first, max 100 |
| PUT | `/v1/handymen/:id/review` | `{ rating, text?, author? }` (`author` null or missing = Anonymous) | `{ handyman, review }` |
| DELETE | `/v1/handymen/:id/review` | | 204 |

Errors use the usual `{ error, message }` shape: `invalid_request` (400), `not_found` (404),
`opted_out` (409, the number asked not to be listed). Adding listings is rate limited to 20 per
hour per member; reviews to 30 per hour.

The `phone` field is shown so people can call. Listings are visible to signed-in members only.
