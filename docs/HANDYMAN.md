# Handyman directory

A shared, public-to-members list of local workers (electricians, plumbers, and any custom trade),
filtered by city then category, with 1–5 star ratings and written reviews.

## Data

- **Handyman**: `id`, `name`, `phone` (E.164), `city`, `category`, `rating` (average, 1 decimal,
  null when unrated), `ratingCount`, `createdAt`. One listing per phone + city + category, so the
  same plumber added twice merges into one card.
- **Review**: `rating` (1–5), `text` (0–500 chars), `author` (the name the reviewer chose, or
  `null` for Anonymous), `createdAt`, `mine` (true on the caller's own review). One review per member
  per handyman: posting again replaces it. Member ids never leave the server.
- City is one of a fixed list of 33 cities (`CITIES` in `src/routes/handymen.ts`, the same list as the app's
  dropdown); any other city is a 400 `invalid_request`. Matching ignores case and extra spaces.
- Category is free text, trimmed and title-cased ("solar fitter" → "Solar Fitter"). Built-in
  categories always keep their own spelling ("ac technician" or "AC Technician" → "AC Technician"). The app suggests the built-in categories: Electrician,
  Plumber, Carpenter, Painter, AC Technician, Mechanic, Mason, Welder, Cleaner. A user may type any
  other category; it shows up for everyone in that city once one listing uses it.
- A number on the opt-out list (`/opt-out`) can't be listed.

## Endpoints (all need the usual `Authorization: Bearer <token>`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/v1/handymen/cities` | | `{ cities: [{ name, count }] }` most listings first |
| GET | `/v1/handymen/categories` | `?city=Lahore` | `{ categories: [{ name, count }] }` for that city |
| GET | `/v1/handymen` | `?city=Lahore&category=Plumber` (category optional, repeatable) `&sort=rating\|new` | `{ handymen: [Handyman] }`, max 200 |
| POST | `/v1/handymen` | `{ name, phone, city, category }` | `Handyman` (201 new, 200 when it merged into an existing listing) |
| GET | `/v1/handymen/:id` | | `{ handyman: Handyman, reviews: [Review] }` newest first, max 100 |
| PUT | `/v1/handymen/:id/review` | `{ rating, text?, author? }` (`author` null or missing = Anonymous) | `{ handyman, review }` |
| DELETE | `/v1/handymen/:id/review` | | 204 |

Errors use the usual `{ error, message }` shape: `invalid_request` (400), `not_found` (404),
`opted_out` (409, the number asked not to be listed). Adding listings is rate limited to 20 per
hour per member; reviews to 30 per hour.

The `phone` field is shown so people can call. Listings are visible to signed-in members only.
