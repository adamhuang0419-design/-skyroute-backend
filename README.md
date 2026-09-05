# Skyroute backend

Real Express + PostgreSQL backend for the flight booking demo. Replaces the
old client-side mock data with actual database-backed search, seat locking,
and bookings.

## Structure
- `server.js` — Express app, serves `public/` and the API routes below
- `db.js` — Postgres connection + schema
- `seed.js` — one-time script that seeds flights + seat maps for every city pair
- `public/index.html` — the frontend (unchanged UI, now calls the real API)
- `render.yaml` — Render blueprint (web service + Postgres database)

## API
- `GET /api/flights?from=台北&to=東京&pax=1` — search flights for a route
- `GET /api/flights/:id/seats` — seat map for a flight
- `POST /api/bookings` — `{ flightId, seatId, name, email, phone, pax, date }`
  → locks the seat inside a transaction and returns `{ referenceCode, totalPrice }`

## Run locally
```
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/skyroute
npm run seed   # one-time: populate flights + seats
npm start
```

## Deploy on Render
`render.yaml` defines a free web service linked to a free Postgres database —
Render wires `DATABASE_URL` in automatically. After the first deploy, run the
seed script once (Render Shell, or a one-off job) to populate flight data.

## Swapping in a real airline API
Flight data currently comes from `seed.js`, a static mock schedule. To use
live data instead, replace the query in the `GET /api/flights` handler in
`server.js` with a call to a real flight-search API — for example
[Duffel](https://duffel.com/docs) or
[Amadeus for Developers](https://developers.amadeus.com), both of which
offer a free sandbox/test API key. The response shape the frontend expects
is:

```json
[{ "id": "...", "airline": "...", "flightNo": "...", "dep": "08:00", "arr": "12:30",
   "duration": "4小時30分", "stops": 0, "totalPrice": 8200 }]
```

Map the provider's response into that shape and the rest of the flow
(seat selection UI, booking form, confirmation) keeps working unchanged.
Seat maps and real payment/ticket issuance would need the provider's own
seat-map and order endpoints, since those aren't standardized the way
search is.
