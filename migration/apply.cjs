/**
 * Applies the Neon DDL (migration/neon/*.sql) inside one transaction, then
 * loads the Supabase snapshot (migration/snapshot/data.json) inside another.
 * Both steps are idempotent from a clean database; any failure rolls back.
 *
 * Usage: node migration/apply.js [--ddl-only|--data-only]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const NEON_DIR = path.join(__dirname, 'neon');
const SNAPSHOT = path.join(__dirname, 'snapshot', 'data.json');

const TABLE_ORDER = [
  'profiles',
  'businesses',
  'business_memberships',
  'accounts',
  'customers',
  'suppliers',
  'journal_entries',
  'journal_lines',
  'sales',
  'sale_items',
  'purchases',
  'purchase_items',
  'expenses',
  'payments',
  'gateway_transactions',
];

function log(msg) {
  console.log(`[apply] ${msg}`);
}

async function ensureRoles() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    for (const role of ['anon', 'service_role']) {
      const r = await client.query('select 1 from pg_roles where rolname = $1', [role]);
      if (r.rows.length === 0) {
        await client.query(`create role ${role} nologin`);
        log(`created role ${role}`);
      } else {
        log(`role ${role} exists`);
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw new Error(`role setup failed: ${e.message}`);
  } finally {
    await client.end();
  }
}

async function applyDdl() {
  const files = fs.readdirSync(NEON_DIR).filter((f) => f.endsWith('.sql') && f !== '000_prelude.sql').sort();
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    for (const f of files) {
      const sql = fs.readFileSync(path.join(NEON_DIR, f), 'utf8');
      await client.query(sql);
      log(`applied ${f}`);
    }
    await client.query('commit');
    log('DDL committed');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw new Error(`DDL failed: ${e.message}`);
  } finally {
    await client.end();
  }
}

async function loadData() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    for (const table of TABLE_ORDER) {
      const rows = snapshot.tables[table] ?? [];
      if (rows.length === 0) {
        log(`${table}: 0 rows, skipped`);
        continue;
      }
      const columns = Object.keys(rows[0]);
      // Reversal rows must load after the entries they reverse — the
      // assert_reversal_shape trigger (016) resolves the original per-row.
      if (table === 'journal_entries') {
        rows.sort((a, b) => (a.reverses_entry_id ? 1 : 0) - (b.reverses_entry_id ? 1 : 0));
      }
      const chunkSize = 200;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const values = [];
        const params = [];
        chunk.forEach((row, r) => {
          const placeholders = columns.map((c, ci) => {
            params.push(row[c]);
            return `$${params.length}`;
          });
          values.push(`(${placeholders.join(', ')})`);
        });
        const sql = `insert into public.${table} (${columns.map((c) => `"${c}"`).join(', ')}) values ${values.join(', ')}`;
        await client.query(sql, params);
        inserted += chunk.length;
      }
      log(`${table}: ${inserted} rows inserted`);
    }
    await client.query('commit');
    log('data committed');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw new Error(`data load failed: ${e.message}`);
  } finally {
    await client.end();
  }
}

async function verify() {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let ok = true;
  try {
    for (const table of TABLE_ORDER) {
      const expected = (snapshot.tables[table] ?? []).length;
      const r = await client.query(`select count(*)::int as n from public.${table}`);
      const match = r.rows[0].n === expected;
      if (!match) ok = false;
      log(`verify ${table}: neon=${r.rows[0].n} supabase=${expected} ${match ? 'OK' : 'MISMATCH'}`);
    }
  } finally {
    await client.end();
  }
  if (!ok) throw new Error('row count verification failed');
  log('all counts match');
}

(async () => {
  const mode = process.argv[2] ?? '';
  if (mode !== '--data-only') {
    await ensureRoles();
    await applyDdl();
  }
  if (mode !== '--ddl-only') {
    await loadData();
    await verify();
  }
  log('done');
})().catch((e) => {
  console.error('[apply] FATAL:', e.message);
  process.exit(1);
});
