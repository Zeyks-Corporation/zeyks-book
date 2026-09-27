require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const r = await pool.query(`select rolname from pg_roles where rolname in ('anon','authenticated','neondb_owner') order by rolname`);
    console.log('roles:', r.rows);
    const t = await pool.query(`
      select c.relname,
        has_table_privilege('authenticated', c.oid, 'SELECT') as sel,
        has_table_privilege('anon', c.oid, 'SELECT') as anon_sel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('inventory_items','inventory_movements','inventory_stock_value')
    `);
    console.table(t.rows);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();