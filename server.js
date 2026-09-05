const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, initSchema } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mock schedule — replace the query in GET /api/flights with a real
// provider call (Duffel / Amadeus for Developers) once you have a key.
const TEMPLATE = [
  { airline: '晴空航空', flight_no: 'SK101', dep: '08:00', arr: '12:30', dur: '4小時30分', stops: 0, price: 8200 },
  { airline: '星際航空', flight_no: 'GX205', dep: '10:15', arr: '15:00', dur: '4小時45分', stops: 0, price: 7650 },
  { airline: '藍天航空', flight_no: 'BS330', dep: '13:40', arr: '20:10', dur: '6小時30分', stops: 1, price: 5900 },
  { airline: '飛翔航空', flight_no: 'FY418', dep: '16:20', arr: '20:50', dur: '4小時30分', stops: 0, price: 9100 },
  { airline: '雲豹航空', flight_no: 'CL512', dep: '19:00', arr: '23:35', dur: '4小時35分', stops: 0, price: 6750 }
];
const CITIES = ['台北', '東京', '首爾', '香港', '曼谷', '新加坡'];
const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Runs once on boot. If the flights table already has data, this is a no-op —
// safe to leave in place permanently (no separate "seed" step needed on Render).
async function seedIfEmpty() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM flights');
  if (rows[0].c > 0) return;
  console.log('flights table is empty — seeding mock schedule...');
  for (const origin of CITIES) {
    for (const destination of CITIES) {
      if (origin === destination) continue;
      for (const f of TEMPLATE) {
        const { rows: fr } = await pool.query(
          `INSERT INTO flights (airline, flight_no, origin, destination, dep_time, arr_time, duration, stops, price_twd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [f.airline, f.flight_no, origin, destination, f.dep, f.arr, f.dur, f.stops, f.price]
        );
        const flightId = fr[0].id;
        const takenCount = 6 + Math.floor(Math.random() * 4);
        const taken = new Set();
        while (taken.size < takenCount) taken.add(Math.floor(Math.random() * 36));
        let i = 0;
        for (let r = 1; r <= 6; r++) {
          for (const c of COLS) {
            await pool.query(
              'INSERT INTO seats (flight_id, seat_number, is_taken) VALUES ($1,$2,$3)',
              [flightId, r + c, taken.has(i)]
            );
            i++;
          }
        }
      }
    }
  }
  console.log('Seed complete.');
}

// GET /api/flights?from=台北&to=東京&pax=1
app.get('/api/flights', async (req, res) => {
  const { from, to, pax } = req.query;
  if (!from || !to) return res.status(400).json({ error: '請提供出發地與目的地' });
  try {
    const { rows } = await pool.query(
      `SELECT id, airline, flight_no, dep_time, arr_time, duration, stops, price_twd
       FROM flights WHERE origin=$1 AND destination=$2 ORDER BY dep_time`,
      [from, to]
    );
    const p = Math.max(1, parseInt(pax, 10) || 1);
    res.json(rows.map((r) => ({
      id: r.id,
      airline: r.airline,
      flightNo: r.flight_no,
      dep: r.dep_time,
      arr: r.arr_time,
      duration: r.duration,
      stops: r.stops,
      pricePerPax: r.price_twd,
      totalPrice: r.price_twd * p
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// GET /api/flights/:id/seats
app.get('/api/flights/:id/seats', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, seat_number, is_taken FROM seats WHERE flight_id=$1 ORDER BY id',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到這個航班' });
    res.json(rows.map((r) => ({ id: r.id, seatNumber: r.seat_number, taken: r.is_taken })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// POST /api/bookings  { flightId, seatId, name, email, phone, pax, from, to, date }
app.post('/api/bookings', async (req, res) => {
  const { flightId, seatId, name, email, phone, pax, date } = req.body || {};
  if (!flightId || !seatId || !name || !email || !phone) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seatRes = await client.query('SELECT is_taken FROM seats WHERE id=$1 FOR UPDATE', [seatId]);
    if (!seatRes.rows.length) { const err = new Error('座位不存在'); err.status = 404; throw err; }
    if (seatRes.rows[0].is_taken) { const err = new Error('這個座位剛被別人訂走了，請重新選位'); err.status = 409; throw err; }

    const flightRes = await client.query('SELECT price_twd FROM flights WHERE id=$1', [flightId]);
    if (!flightRes.rows.length) { const err = new Error('航班不存在'); err.status = 404; throw err; }

    const p = Math.max(1, parseInt(pax, 10) || 1);
    const total = flightRes.rows[0].price_twd * p;

    await client.query('UPDATE seats SET is_taken=TRUE WHERE id=$1', [seatId]);

    const ref = 'BK' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await client.query(
      `INSERT INTO bookings (reference_code, flight_id, seat_id, passenger_name, passenger_email, passenger_phone, passengers, total_price, search_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ref, flightId, seatId, name, email, phone, p, total, date || null]
    );
    await client.query('COMMIT');
    res.json({ referenceCode: ref, totalPrice: total });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(e.status || 500).json({ error: e.status ? e.message : '伺服器錯誤' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
initSchema()
  .then(seedIfEmpty)
  .then(() => app.listen(PORT, () => console.log('Server running on port ' + PORT)))
  .catch((e) => { console.error('DB init failed', e); process.exit(1); });
