const { Pool } = require('pg');

// Render injects DATABASE_URL automatically when a Postgres instance
// is linked to this web service. Locally, set it in a .env / your shell.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flights (
      id SERIAL PRIMARY KEY,
      airline TEXT NOT NULL,
      flight_no TEXT NOT NULL,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      dep_time TEXT NOT NULL,
      arr_time TEXT NOT NULL,
      duration TEXT NOT NULL,
      stops INTEGER NOT NULL DEFAULT 0,
      price_twd INTEGER NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      flight_id INTEGER REFERENCES flights(id),
      seat_number TEXT NOT NULL,
      is_taken BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(flight_id, seat_number)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      reference_code TEXT UNIQUE NOT NULL,
      flight_id INTEGER REFERENCES flights(id),
      seat_id INTEGER REFERENCES seats(id),
      passenger_name TEXT NOT NULL,
      passenger_email TEXT NOT NULL,
      passenger_phone TEXT NOT NULL,
      passengers INTEGER NOT NULL DEFAULT 1,
      total_price INTEGER NOT NULL,
      search_date TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { pool, initSchema };
