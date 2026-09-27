require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');

// Simulate the "authenticated" role connecting as user 65aef6e2-...
// and reading inventory_items to confirm RLS + grant now work.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function asAuth(uid, fn) {
  const c = await pool.connect();
  try {
    // Data API connects as `authenticated` and sets `request.jwt.claims` json
    // containing the sub. We mimic that by using SET LOCAL inside a tx.
    await c.query('begin');
    await c.query(`set local role authenticated`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    return await fn(c);
  } finally {
    try { await c.query('rollback'); } catch {}
    c.release();
  }
}

(async () => {
  const uid = '65aef6e2-b503-4680-aa82-6bfae535b377';
  try {
    const inv = await asAuth(uid, async (c) => {
      const r = await c.query('select count(*) from public.inventory_items');
      return r.rows[0].count;
    });
    console.log('inventory_items count for owner:', inv);

    const mov = await asAuth(uid, async (c) => {
      const r = await c.query('select count(*) from public.inventory_movements');
      return r.rows[0].count;
    });
    console.log('inventory_movements count for owner:', mov);

    const sv = await asAuth(uid, async (c) => {
      const r = await c.query('select count(*) from public.inventory_stock_value');
      return r.rows[0].count;
    });
    console.log('inventory_stock_value count for owner:', sv);

    // Business UPDATE: try setting currency_symbol to a known value, then read it back.
    const upd = await asAuth(uid, async (c) => {
      const r = await c.query(
        `update public.businesses set currency_symbol = currency_symbol
         where id = 'aba1af29-6b0e-4ebc-aece-d1e74309bcb2'
         returning id, currency_symbol`
      );
      return r.rows[0];
    });
    console.log('businesses UPDATE result for owner:', upd);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();