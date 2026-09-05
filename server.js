const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, initSchema } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  .then(() => app.listen(PORT, () => console.log('Server running on port ' + PORT)))
  .catch((e) => { console.error('DB init failed', e); process.exit(1); });
