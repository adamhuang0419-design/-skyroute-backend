const express = require('express');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
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
  const legs = offer.slices.map(function (slice) {
    const segs = slice.segments || [];
    const first = segs[0], last = segs[segs.length - 1];
    return {
      dep: (first.departing_at || '').slice(11, 16),
      arr: (last.arriving_at || '').slice(11, 16),
      duration: parseDuration(slice.duration),
      stops: segs.length - 1
    };
  });
  const firstSeg = offer.slices[0].segments[0];
  const carrier = (firstSeg.marketing_carrier && firstSeg.marketing_carrier.name) || (offer.owner && offer.owner.name) || '未知航空';
  const flightNo = ((firstSeg.marketing_carrier && firstSeg.marketing_carrier.iata_code) || '') + (firstSeg.marketing_carrier_flight_number || firstSeg.operating_carrier_flight_number || '');
  const maxStops = Math.max.apply(null, legs.map(function (l) { return l.stops; }));
  return {
    source: 'duffel',
    airline: carrier,
    flightNo: flightNo,
    legs: legs,
    dep: legs[0].dep, arr: legs[0].arr, duration: legs[0].duration,
    stops: maxStops,
    currency: offer.total_currency || 'USD',
    totalPrice: parseFloat(offer.total_amount)
  };
}

// Real flight search via Duffel (test-mode sandbox). opts.slices is an array of
// {origin, destination, departure_date} — 1 leg for one-way, 2 for round-trip,
// 2-6 for multi-city. Falls back to the local mock schedule (simple one-leg
// lookups only) if Duffel errors out or has no availability.
async function searchDuffel(opts) {
  const key = process.env.DUFFEL_API_KEY;
  if (!key) return null;
  const passengers = [];
  for (let i = 0; i < opts.adults; i++) passengers.push({ type: 'adult' });
  for (let i = 0; i < opts.children; i++) passengers.push({ type: 'child', age: 8 });
  for (let i = 0; i < opts.infants; i++) passengers.push({ type: 'infant_without_seat', age: 1 });

  const data = { passengers, slices: opts.slices };
  if (opts.cabin) data.cabin_class = opts.cabin;

  const resp = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip',
      'Duffel-Version': 'v2',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify({ data })
  });
  const json = await resp.json();
  if (!resp.ok) {
    const msg = (json.errors && json.errors[0] && json.errors[0].message) || ('Duffel HTTP ' + resp.status);
    throw new Error(msg);
  }
  const offers = (json.data && json.data.offers) || [];
  return offers.slice(0, 8).map(mapDuffelOffer);
}

const CITY_ZH_EN = {
  '台北':'Taipei','臺北':'Taipei','高雄':'Kaohsiung','台中':'Taichung','台南':'Tainan','臺中':'Taichung','臺南':'Tainan',
  '東京':'Tokyo','大阪':'Osaka','名古屋':'Nagoya','福岡':'Fukuoka','札幌':'Sapporo','沖繩':'Okinawa','京都':'Kyoto',
  '首爾':'Seoul','釜山':'Busan','濟州':'Jeju',
  '香港':'Hong Kong','澳門':'Macau',
  '北京':'Beijing','上海':'Shanghai','廣州':'Guangzhou','深圳':'Shenzhen','成都':'Chengdu','杭州':'Hangzhou','廈門':'Xiamen','西安':'Xian','重慶':'Chongqing','青島':'Qingdao','南京':'Nanjing',
  '新加坡':'Singapore',
  '曼谷':'Bangkok','清邁':'Chiang Mai','普吉島':'Phuket',
  '吉隆坡':'Kuala Lumpur','檳城':'Penang',
  '峇里島':'Bali','巴里島':'Bali','雅加達':'Jakarta',
  '馬尼拉':'Manila','宿霧':'Cebu',
  '河內':'Hanoi','胡志明市':'Ho Chi Minh City','峴港':'Da Nang',
  '金邊':'Phnom Penh','仰光':'Yangon','永珍':'Vientiane',
  '新德里':'New Delhi','孟買':'Mumbai','班加羅爾':'Bangalore',
  '杜拜':'Dubai','多哈':'Doha','伊斯坦堡':'Istanbul','特拉維夫':'Tel Aviv','利雅德':'Riyadh',
  '倫敦':'London','巴黎':'Paris','法蘭克福':'Frankfurt','慕尼黑':'Munich','羅馬':'Rome','米蘭':'Milan',
  '阿姆斯特丹':'Amsterdam','蘇黎世':'Zurich','馬德里':'Madrid','巴塞隆納':'Barcelona','維也納':'Vienna','布拉格':'Prague','都柏林':'Dublin',
  '紐約':'New York','洛杉磯':'Los Angeles','舊金山':'San Francisco','西雅圖':'Seattle','芝加哥':'Chicago','拉斯維加斯':'Las Vegas','檀香山':'Honolulu','波士頓':'Boston','華盛頓':'Washington',
  '溫哥華':'Vancouver','多倫多':'Toronto',
  '雪梨':'Sydney','墨爾本':'Melbourne','奧克蘭':'Auckland','布里斯本':'Brisbane'
};

// GET /api/places?query=X — proxies Duffel's place suggestion API for autocomplete.
// Chinese queries are translated to the English/romanised names Duffel indexes by.
app.get('/api/places', async (req, res) => {
  const q = (req.query.query || '').trim();
  if (!q.length) return res.json([]);
  const key = process.env.DUFFEL_API_KEY;
  if (!key) return res.json([]);

  let terms = [q];
  if (/[\u4e00-\u9fff]/.test(q)) {
    const matches = Object.keys(CITY_ZH_EN).filter(function (zh) { return zh.indexOf(q) === 0 || q.indexOf(zh) === 0; });
    terms = matches.map(function (zh) { return CITY_ZH_EN[zh]; });
    if (!terms.length) return res.json([]); // Chinese text with no known translation — Duffel can't match it
  }
  if (terms[0].length < 2) return res.json([]);

  try {
    const seen = new Set();
    const results = [];
    for (const term of terms.slice(0, 4)) {
      const resp = await fetch('https://api.duffel.com/places/suggestions?query=' + encodeURIComponent(term), {
        headers: { 'Accept-Encoding': 'gzip', 'Duffel-Version': 'v2', 'Authorization': 'Bearer ' + key }
      });
      const json = await resp.json();
      if (!resp.ok) continue;
      (json.data || []).forEach(function (p) {
        if (!p.iata_code || seen.has(p.iata_code)) return;
        seen.add(p.iata_code);
        results.push({ iataCode: p.iata_code, name: p.name, type: p.type, cityName: (p.city && p.city.name) || p.name });
      });
    }
    res.json(results.slice(0, 8));
  } catch (e) {
    console.error('places search failed', e.message);
    res.json([]);
  }
});

const IATA_REV = {}; Object.keys(IATA).forEach(function (zh) { IATA_REV[IATA[zh]] = zh; });

// GET /api/flights?segments=[{"origin":"TPE","destination":"TYO","date":"2026-12-15"}, ...]
//     &tripType=oneway|roundtrip|multicity&cabin=any|economy|premium_economy|business|first
//     &directOnly=true|false&adults=N&children=N&infants=N
app.get('/api/flights', async (req, res) => {
  let segments;
  try { segments = JSON.parse(req.query.segments || '[]'); } catch (e) { segments = []; }
  if (!Array.isArray(segments) || !segments.length) return res.status(400).json({ error: '請提供航段資訊' });
  for (const s of segments) { if (!s.origin || !s.destination || !s.date) return res.status(400).json({ error: '航段資訊不完整' }); }

  const { cabin, directOnly } = req.query;
  const adults = Math.max(1, parseInt(req.query.adults, 10) || 1);
  const children = Math.max(0, parseInt(req.query.children, 10) || 0);
  const infants = Math.max(0, parseInt(req.query.infants, 10) || 0);
  const pax = adults + children + infants;

  try {
    const offers = await searchDuffel({
      slices: segments.map(function (s) { return { origin: s.origin, destination: s.destination, departure_date: s.date }; }),
      adults, children, infants,
      cabin: cabin && cabin !== 'any' ? cabin : null
    });
    let result = offers || [];
    if (directOnly === 'true') result = result.filter(function (o) { return o.stops === 0; });
    if (result.length) return res.json(result);
  } catch (e) {
    console.error('Duffel search failed, falling back to mock data:', e.message);
  }

  if (segments.length === 1) {
    try {
      const zhOrigin = IATA_REV[segments[0].origin] || segments[0].origin;
      const zhDest = IATA_REV[segments[0].destination] || segments[0].destination;
      const { rows } = await pool.query(
        `SELECT id, airline, flight_no, dep_time, arr_time, duration, stops, price_twd
         FROM flights WHERE origin=$1 AND destination=$2 ORDER BY dep_time`,
        [zhOrigin, zhDest]
      );
      let mock = rows.map((r) => ({
        source: 'mock', localFlightId: r.id, airline: r.airline, flightNo: r.flight_no,
        legs: [{ dep: r.dep_time, arr: r.arr_time, duration: r.duration, stops: r.stops }],
        dep: r.dep_time, arr: r.arr_time, duration: r.duration, stops: r.stops,
        currency: 'TWD', totalPrice: r.price_twd * pax
      }));
      if (directOnly === 'true') mock = mock.filter(function (o) { return o.stops === 0; });
      return res.json(mock);
    } catch (e) {
      console.error(e);
    }
  }
  res.json([]);
});

// POST /api/select-offer — registers a chosen offer (Duffel or mock) as a local
// flight row, so booking always has a server-side source of truth for price.
app.post('/api/select-offer', async (req, res) => {
  const { source, localFlightId, airline, flightNo, dep, arr, duration, stops, totalPrice, currency, from, to, pax } = req.body || {};
  const p = Math.max(1, parseInt(pax, 10) || 1);

  try {
    if (source === 'mock' && localFlightId) {
      return res.json({ flightId: localFlightId, currency: currency || 'TWD' });
    }
    if (!airline || totalPrice == null) return res.status(400).json({ error: '缺少航班資訊' });
    const perPax = Math.round(totalPrice / p);
    const { rows } = await pool.query(
      `INSERT INTO flights (airline, flight_no, origin, destination, dep_time, arr_time, duration, stops, price_twd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [airline, flightNo || '', from || '', to || '', dep || '', arr || '', duration || '', stops || 0, perPax]
    );
    res.json({ flightId: rows[0].id, currency: currency || 'TWD' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// POST /api/bookings  { flightId, name, email, phone, pax, date }
app.post('/api/bookings', async (req, res) => {
  const { flightId, name, email, phone, pax, date } = req.body || {};
  if (!flightId || !name || !email || !phone) {
    return res.status(400).json({ error: '缺少必要欄位' });
  }
  try {
    const flightRes = await pool.query('SELECT price_twd FROM flights WHERE id=$1', [flightId]);
    if (!flightRes.rows.length) return res.status(404).json({ error: '航班不存在' });

    const p = Math.max(1, parseInt(pax, 10) || 1);
    const total = flightRes.rows[0].price_twd * p;
    const ref = 'BK' + crypto.randomBytes(4).toString('hex').toUpperCase();
    await pool.query(
      `INSERT INTO bookings (reference_code, flight_id, passenger_name, passenger_email, passenger_phone, passengers, total_price, search_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ref, flightId, name, email, phone, p, total, date || null]
    );
    res.json({ referenceCode: ref, totalPrice: total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// ---- Admin (single shared password via ADMIN_PASSWORD env var) ----
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD || pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: '未授權' });
  }
  next();
}

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: '後台尚未設定密碼（ADMIN_PASSWORD）' });
  if (password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: '密碼錯誤' });
  res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const totals = await pool.query("SELECT COUNT(*)::int AS c, COALESCE(SUM(total_price),0)::int AS revenue FROM bookings WHERE status != 'refunded'");
    const today = await pool.query("SELECT COUNT(*)::int AS c FROM bookings WHERE created_at::date = CURRENT_DATE");
    const refunded = await pool.query("SELECT COUNT(*)::int AS c FROM bookings WHERE status='refunded'");
    res.json({
      totalBookings: totals.rows[0].c, totalRevenue: totals.rows[0].revenue,
      todayBookings: today.rows[0].c, refundedCount: refunded.rows[0].c
    });
  } catch (e) { console.error(e); res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  const { search, status, from, to } = req.query;
  const conditions = []; const params = [];
  if (search) { params.push('%' + search + '%'); conditions.push('(b.reference_code ILIKE $' + params.length + ' OR b.passenger_name ILIKE $' + params.length + ' OR b.passenger_email ILIKE $' + params.length + ')'); }
  if (status) { params.push(status); conditions.push('b.status = $' + params.length); }
  if (from) { params.push(from); conditions.push('b.created_at >= $' + params.length + '::date'); }
  if (to) { params.push(to); conditions.push("b.created_at < $" + params.length + "::date + interval '1 day'"); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  try {
    const { rows } = await pool.query(
      `SELECT b.reference_code, b.passenger_name, b.passenger_email, b.passenger_phone, b.passengers, b.total_price, b.status, b.created_at,
              f.airline, f.flight_no, f.origin, f.destination, f.dep_time, f.arr_time
       FROM bookings b JOIN flights f ON f.id = b.flight_id
       ${where} ORDER BY b.created_at DESC LIMIT 200`,
      params
    );
    res.json(rows.map((r) => ({
      referenceCode: r.reference_code, passengerName: r.passenger_name, passengerEmail: r.passenger_email, passengerPhone: r.passenger_phone,
      passengers: r.passengers, totalPrice: r.total_price, status: r.status, createdAt: r.created_at,
      airline: r.airline, flightNo: r.flight_no, origin: r.origin, destination: r.destination, depTime: r.dep_time, arrTime: r.arr_time
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: '伺服器錯誤' }); }
});

app.post('/api/admin/bookings/:ref/refund', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE bookings SET status='refunded' WHERE reference_code=$1 AND status != 'refunded' RETURNING reference_code",
      [req.params.ref]
    );
    if (!rows.length) return res.status(404).json({ error: '找不到訂單，或這筆已經是退票狀態' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.reference_code, b.passenger_name, b.passenger_email, b.total_price, b.status, b.created_at,
              f.airline, f.flight_no, f.origin, f.destination
       FROM bookings b JOIN flights f ON f.id = b.flight_id ORDER BY b.created_at DESC`
    );
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const header = 'reference_code,passenger_name,passenger_email,total_price,status,created_at,airline,flight_no,origin,destination\n';
    const body = rows.map((r) => [r.reference_code, r.passenger_name, r.passenger_email, r.total_price, r.status, r.created_at, r.airline, r.flight_no, r.origin, r.destination].map(esc).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="skyroute-bookings.csv"');
    res.send('\uFEFF' + header + body);
  } catch (e) { console.error(e); res.status(500).send('Error'); }
});

const PORT = process.env.PORT || 3000;

// GET /api/bookings?email=X — order history lookup (no account system, so
// email is the lookup key, same as how the booking was made).
app.get('/api/bookings', async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: '請提供 Email' });
  try {
    const { rows } = await pool.query(
      `SELECT b.reference_code, b.passenger_name, b.total_price, b.created_at,
              f.airline, f.flight_no, f.origin, f.destination, f.dep_time, f.arr_time
       FROM bookings b JOIN flights f ON f.id = b.flight_id
       WHERE b.passenger_email = $1
       ORDER BY b.created_at DESC LIMIT 20`,
      [email]
    );
    res.json(rows.map((r) => ({
      referenceCode: r.reference_code, passengerName: r.passenger_name, totalPrice: r.total_price,
      airline: r.airline, flightNo: r.flight_no, origin: r.origin, destination: r.destination,
      depTime: r.dep_time, arrTime: r.arr_time
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '伺服器錯誤' });
  }
});

// GET /api/bookings/:ref/qrcode — e-ticket QR code for a booking reference.
app.get('/api/bookings/:ref/qrcode', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT reference_code FROM bookings WHERE reference_code=$1', [req.params.ref]);
    if (!rows.length) return res.status(404).json({ error: '找不到這筆訂單' });
    const dataUrl = await QRCode.toDataURL('SKYROUTE|' + req.params.ref, { width: 240, margin: 1 });
    res.json({ qrCodeDataUrl: dataUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '產生 QR Code 失敗' });
  }
});

initSchema()
  .then(seedIfEmpty)
  .then(() => app.listen(PORT, () => console.log('Server running on port ' + PORT)))
  .catch((e) => { console.error('DB init failed', e); process.exit(1); });
