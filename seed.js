const { pool, initSchema } = require('./db');

// Mock schedule template — replace this module with a real provider call
// (e.g. Duffel / Amadeus for Developers) once you have API credentials.
// See README.md for where that swap happens.
const TEMPLATE = [
  { airline: '晴空航空', flight_no: 'SK101', dep: '08:00', arr: '12:30', dur: '4小時30分', stops: 0, price: 8200 },
  { airline: '星際航空', flight_no: 'GX205', dep: '10:15', arr: '15:00', dur: '4小時45分', stops: 0, price: 7650 },
  { airline: '藍天航空', flight_no: 'BS330', dep: '13:40', arr: '20:10', dur: '6小時30分', stops: 1, price: 5900 },
  { airline: '飛翔航空', flight_no: 'FY418', dep: '16:20', arr: '20:50', dur: '4小時30分', stops: 0, price: 9100 },
  { airline: '雲豹航空', flight_no: 'CL512', dep: '19:00', arr: '23:35', dur: '4小時35分', stops: 0, price: 6750 }
];
const CITIES = ['台北', '東京', '首爾', '香港', '曼谷', '新加坡'];
const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];
const ROWS = 6;

async function seed() {
  await initSchema();
  const { rows: existing } = await pool.query('SELECT COUNT(*)::int AS c FROM flights');
  if (existing[0].c > 0) {
    console.log('flights table already has data — skipping seed.');
    await pool.end();
    return;
  }

  for (const origin of CITIES) {
    for (const destination of CITIES) {
      if (origin === destination) continue;
      for (const f of TEMPLATE) {
        const { rows } = await pool.query(
          `INSERT INTO flights (airline, flight_no, origin, destination, dep_time, arr_time, duration, stops, price_twd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [f.airline, f.flight_no, origin, destination, f.dep, f.arr, f.dur, f.stops, f.price]
        );
        const flightId = rows[0].id;
        const takenCount = 6 + Math.floor(Math.random() * 4);
        const taken = new Set();
        while (taken.size < takenCount) taken.add(Math.floor(Math.random() * ROWS * COLS.length));

        let i = 0;
        for (let r = 1; r <= ROWS; r++) {
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
  console.log('Seeded flights + seat maps for all city pairs.');
  await pool.end();
}

seed().catch((e) => { console.error(e); process.exit(1); });
