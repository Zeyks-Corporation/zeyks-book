// Apply a migration file via the connection string in DATABASE_URL_UNPOOLED.
// Usage: node migration/_apply.mjs migration/neon/020_inventory.sql
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import 'dotenv/config';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node migration/_apply.mjs <path-to-sql>');
  process.exit(2);
}

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(2);
}

const sql = readFileSync(file, 'utf8');
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  console.log(`Applying ${file} (${sql.length} bytes)…`);
  await client.query(sql);
  console.log('OK');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
} finally {
  await client.end();
}