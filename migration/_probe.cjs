require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query(`
    select table_schema, table_name, column_name, data_type, udt_name
      from information_schema.columns
     where table_schema = 'neon_auth'
     order by table_name, ordinal_position;
    select n.nspname, c.relname, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'neon_auth';
  `);
  console.log(JSON.stringify(r, null, 2));
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });