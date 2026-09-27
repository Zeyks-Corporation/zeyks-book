require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
(async () => {
  try {
    const cols = await pool.query(`select column_name from information_schema.columns where table_schema = 'neon_auth' and table_name = 'user' order by ordinal_position`);
    console.log('neon_auth.user columns:', cols.rows.map(r => r.column_name));
    const r = await pool.query(`select id::text, email from neon_auth."user" limit 20`);
    console.log('All neon_auth users:');
    console.table(r.rows);
    const s = await pool.query(`select id::text, account_id::text, provider_id, user_id::text from neon_auth.session limit 20`);
    console.log('Active sessions:');
    console.table(s.rows);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();