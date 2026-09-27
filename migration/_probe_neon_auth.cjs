require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(`
    select table_schema, table_name
      from information_schema.tables
     where table_schema in ('neon_auth', 'public')
       and table_type = 'BASE TABLE'
     order by table_schema, table_name
  `);
  console.log('Tables visible to the project owner:');
  for (const r of rows) console.log(`  ${r.table_schema}.${r.table_name}`);

  console.log('\nneon_auth schema row counts:');
  for (const r of rows.filter((x) => x.table_schema === 'neon_auth')) {
    try {
      const q = `select count(*)::int as n from "${r.table_schema}"."${r.table_name}"`;
      const c = await client.query(q);
      console.log(`  ${r.table_name.padEnd(28)} ${c.rows[0].n}`);
    } catch (e) {
      console.log(`  ${r.table_name.padEnd(28)} (cannot query: ${e.message.slice(0, 80)})`);
    }
  }

  await client.end();
})();