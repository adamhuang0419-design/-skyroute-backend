const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, initSchema } = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- mock schedule, kept as a fallback if Duffel has no availability ----
const TEMPLATE = [
  { airline: '晴空航空', flight_no: 'SK101', dep: '08:00', arr: '12:30', dur: '4小時30分', stops: 0, price: 8200 },
  { airline: '星際航空', flight_no: 'GX205', dep: '10:15', arr: '15:00', dur: '4小時45分', stops: 0, price: 7650 },
  { airline: '藍天航空', flight_no: 'BS330', dep: '13:40', arr: '20:10', dur: '6小時30分', stops: 1, price: 5900 },
  { airline: '飛翔航空', flight_no: 'FY418', dep: '16:20', arr: '20:50', dur: '4小時30分', stops: 0, price: 9100 },
  { airline: '雲豹航空', flight_no: 'CL512', dep: '19:00', arr: '23:35', dur: '4小時35分', stops: 0, price: 6750 }
];
const CITIES = ['台北', '東京', '首爾', '香港', '曼谷', '新加坡'];
const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];
const IATA = { '台北': 'TPE', '東京': 'TYO', '首爾': 'SEL', '香港': 'HKG', '曼谷': 'BKK', '新加坡': 'SIN' };

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
            await pool.query('INSERT INTO seats (flight_id, seat_number, is_taken) VALUES ($1,$2,$3)', [flightId, r + c, taken.has(i)]);
            i++;
          }
        }
      }
    }
  }
  console.log('Seed complete.');
}

function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso || '');
  const h = m && m[1] ? parseInt(m[1], 10) : 0;
  const mi = m && m[2] ? parseInt(m[2], 10) : 0;
  if (h && mi) return h + '小時' + mi + '分';
  if (h) return h + '小時';
  return (mi || 0) + '分';
}

function mapDuffelOffer(offer) {
  const slice = offer.slices[0];
  const segments = slice.segments || [];
  const first = segments[0], last = segments[segments.length - 1];
  const carrier = (first.marketing_carrier && first.marketing_carrier.name) || (offer.owner && offer.owner.name) || '未知航空';
  const flightNo = ((first.marketing_carrier && first.marketing_carrier.iata_code) || '') + (first.marketing_carrier_flight_number || first.operating_carrier_flight_number || '');
  return {
    source: 'duffel',
    airline: carrier,
    flightNo: flightNo,
    dep: (first.departing_at || '').slice(11, 16),
    arr: (last.arriving_at || '').slice(11, 16),
    duration: parseDuration(slice.duration),
    stops: segments.length - 1,
    currency: offer.total_currency || 'USD',
    totalPrice: parseFloat(offer.total_amount)
  };
}

// Real flight search via Duffel (test-mode sandbox). Falls back to the local
// mock schedule if Duffel errors out or has no availability for the route/date.
async function searchDuffel(origin, destination, date, pax) {
  const key = process.env.DUFFEL_API_KEY;
  if (!key) return null;
  const passengers = Array.from({ length: pax }, () => ({ type: 'adult' }));
  const body = { data: { cabin_class: 'economy', passengers, slices: [{ origin, destination, departure_date: date }] } };
  const resp = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      'Duffel-Version': 'v2',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(body)
  });
  const json = await resp.json();
  if (!resp.ok) {
    const msg = (json.errors && json.errors[0] && json.errors[0].message) || ('Duffel HTTP ' + resp.status);
    throw new Error(msg);
  }
  const offers = (json.data && json.data.offers) || [];
  return offers.slice(0, 8).map(mapDuffelOffer);
}

// GET /api/flights?from=台北&to=東京&pax=1&date=2026-12-15
app.get('/api/flights', async (req, res) => {
  const { from, to, pax, date } = req.query;
  if (!from || !to) return res.status(400).json({ error: '請提供出發地與目的地' });
  const p = Math.max(1, parseInt(pax, 10) || 1);
  const searchDate = date || new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const originCode = IATA[from], destCode = IATA[to];

  if (originCode && destCode) {
    try {
      const offers = await searchDuffel(originCode, destCode, searchDate, p);
      if (offers && offers.length) return res.json(offers);
    } catch (e) {
      console.error('Duffel search failed, falling back to mock data:', e.message);
    }
  }

  // fallback: local mock schedule
  try {
    const { rows } = await pool.query(
      `SELECT id, airline, flight_no, dep_time, arr_time, duration, stops, price_twd
       FROM flights WHERE origin=$1 AND destination=$2 ORDER BY dep_time`,
      [from, to]
    );
    res.json(rows.map((r) => ({
      source: 'mock', localFlightId: r.id, airline: r.airline, flightNo: r.flight_no,
      dep: r.dep_time, arr: r.arr_time, duration: r.duration, stops: r.stops,
      currency: 'TWD', totalPrice: r.price_twd * p
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// POST /api/select-offer — turns a chosen offer (Duffel or mock) into a local
// flight row + a fresh seat map, so the rest of the flow (seat pick, booking)
// always works against our own database.
app.post('/api/select-offer', async (req, res) => {
  const { source, localFlightId, airline, flightNo, dep, arr, duration, stops, totalPrice, currency, from, to, pax } = req.body || {};
  const p = Math.max(1, parseInt(pax, 10) || 1);

  try {
    if (source === 'mock' && localFlightId) {
      const { rows } = await pool.query('SELECT id FROM seats WHERE flight_id=$1 LIMIT 1', [localFlightId]);
      if (rows.length) return res.json({ flightId: localFlightId, currency: currency || 'TWD' });
    }
    if (!airline || totalPrice == null) return res.status(400).json({ error: '缺少航班資訊' });
    const perPax = Math.round(totalPrice / p);
    const { rows } = await pool.query(
      `INSERT INTO flights (airline, flight_no, origin, destination, dep_time, arr_time, duration, stops, price_twd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [airline, flightNo || '', from || '', to || '', dep || '', arr || '', duration || '', stops || 0, perPax]
    );
    const flightId = rows[0].id;
    const taken = new Set();
    while (taken.size < 8) taken.add(Math.floor(Math.random() * 36));
    let i = 0;
    for (let r = 1; r <= 6; r++) {
      for (const c of COLS) {
        await pool.query('INSERT INTO seats (flight_id, seat_number, is_taken) VALUES ($1,$2,$3)', [flightId, r + c, taken.has(i)]);
        i++;
      }
    }
    res.json({ flightId, currency: currency || 'TWD' });
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

// POST /api/bookings  { flightId, seatId, name, email, phone, pax, date }
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
