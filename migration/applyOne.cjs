/**
 * Applies a single migration file to Neon. Used to layer post-cutover
 * changes on top of an already-loaded database without re-running 001-017.
 *
 * The pooler URL strips ownership on GRANT / REVOKE statements, so any
 * migration that touches grants uses DATABASE_URL_UNPOOLED by default.
 * Pass --pooler to force the pooler (only safe for SELECT/INSERT/UPDATE
 * statements that don't need to grant privileges).
 *
 * Usage: node migration/applyOne.cjs <path-to-sql-file> [--pooler]
 */
require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

const file = process.argv[2];
if (!file) {
  console.error('usage: node migration/applyOne.cjs <sql-file> [--pooler]');
  process.exit(2);
}
const usePooler = process.argv.includes('--pooler');
const conn = usePooler ? process.env.DATABASE_URL : process.env.DATABASE_URL_UNPOOLED;
if (!conn) {
  console.error('missing connection string (DATABASE_URL[_UNPOOLED])');
  process.exit(2);
}

(async () => {
  const sql = fs.readFileSync(file, 'utf8');
  const client = new Client({ connectionString: conn });
  await client.connect();
  try {
    await client.query(sql);
    console.log(`[applyOne] applied ${file}${usePooler ? ' (pooler)' : ' (unpooled)'}`);
  } catch (e) {
    console.error('[applyOne] FAILED:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();