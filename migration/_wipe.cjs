/**
 * Wipe the entire zeyks-book dataset for a fresh start.
 *
 * Scope
 *   * TRUNCATE every public-schema data table (rows only — schema, RLS,
 *     functions, grants all stay intact so the app keeps working).
 *   * DELETE every Neon Auth user so a re-sign-in lands on a brand-new id.
 *
 * Append-only note
 *   The forbid_modification() trigger blocks DELETE and TRUNCATE on the
 *   financial tables by design (see 001_core_tables.sql). We DROP those
 *   triggers, run the truncate, then recreate them from the original
 *   definitions so the integrity guarantees survive the wipe.
 *
 * What does NOT get touched
 *   * The neon_auth schema itself (managed by Neon; we delete rows through
 *     `neon neon-auth user delete`, not by truncating the underlying table).
 *   * Any functions, policies, types, or extensions.
 *
 * Usage: node migration/_wipe.cjs
 */
require('dotenv').config();
const { execSync } = require('node:child_process');
const { Client } = require('pg');

// Tables covered by forbid_modification() (DELETE + TRUNCATE blocked).
// The truncate-blocked list, per migration/neon/001_core_tables.sql:378-381.
const FORBID_TABLES = [
  'businesses', 'customers', 'suppliers', 'accounts',
  'sales', 'sale_items', 'purchases', 'purchase_items',
  'expenses', 'payments', 'gateway_transactions',
  'journal_entries', 'journal_lines',
];
// Plus journal_lines, sale_items, purchase_items also have UPDATE blocked.

// Tables NOT in the forbid list — truncate directly:
const PLAIN_TABLES = [
  'inventory_movements', 'inventory_items',
  'business_memberships', 'profiles', 'auth_otp_challenges',
];

function safeNeon(args) {
  const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
  return execSync(`neon ${args}`, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function counts(client, tables) {
  const out = {};
  for (const t of tables) {
    const { rows } = await client.query(`select count(*)::int as n from public.${t}`);
    out[t] = rows[0].n;
  }
  return out;
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  console.log('--- BEFORE: row counts ---');
  const all = [...FORBID_TABLES, ...PLAIN_TABLES];
  const before = await counts(client, all);
  for (const t of all) console.log(`  ${t.padEnd(28)} ${before[t]}`);

  console.log('\n--- DROP forbid_modification triggers ---');
  await client.query('begin');
  try {
    for (const t of FORBID_TABLES) {
      await client.query(`drop trigger if exists ${t}_no_delete on public.${t}`);
      await client.query(`drop trigger if exists ${t}_no_truncate on public.${t}`);
    }
    for (const t of ['journal_lines', 'sale_items', 'purchase_items']) {
      await client.query(`drop trigger if exists ${t}_no_update on public.${t}`);
    }

    const allTables = all.map((t) => `public.${t}`).join(', ');
    await client.query(`TRUNCATE ${allTables} RESTART IDENTITY CASCADE`);
    console.log(`  truncated ${all.length} tables`);

    // Recreate the forbid_modification triggers verbatim from 001_core_tables.sql.
    for (const t of FORBID_TABLES) {
      await client.query(
        `create trigger ${t}_no_delete before delete on public.${t} for each row execute function public.forbid_modification()`,
      );
      await client.query(
        `create trigger ${t}_no_truncate before truncate on public.${t} for each statement execute function public.forbid_modification()`,
      );
    }
    for (const t of ['journal_lines', 'sale_items', 'purchase_items']) {
      await client.query(
        `create trigger ${t}_no_update before update on public.${t} for each row execute function public.forbid_modification()`,
      );
    }
    console.log('  recreated forbid_modification triggers');

    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  }

  console.log('\n--- AFTER: row counts ---');
  const after = await counts(client, all);
  for (const t of all) console.log(`  ${t.padEnd(28)} ${after[t]}`);

  await client.end();

  console.log('\n--- Neon Auth users BEFORE ---');
  let authUsers = [];
  try {
    const raw = safeNeon('neon-auth user list -o json');
    authUsers = JSON.parse(raw);
    if (Array.isArray(authUsers)) {
      for (const u of authUsers) {
        console.log(`  ${u.id}  ${u.email || '(no email)'}  ${u.name || ''}`);
      }
    } else {
      console.log(`  (unparsed: ${raw.slice(0, 200)})`);
    }
  } catch (e) {
    console.log(`  could not list: ${e.message}`);
  }

  if (Array.isArray(authUsers) && authUsers.length > 0) {
    console.log(`\n--- DELETE ${authUsers.length} Neon Auth users ---`);
    for (const u of authUsers) {
      try {
        safeNeon(`neon-auth user delete ${u.id}`);
        console.log(`  deleted ${u.id} (${u.email || 'no email'})`);
      } catch (e) {
        console.log(`  FAILED ${u.id}: ${e.message}`);
      }
    }
  } else {
    console.log('\n--- DELETE Neon Auth users: nothing to delete ---');
  }

  console.log('\n--- Neon Auth users AFTER ---');
  try {
    const raw = safeNeon('neon-auth user list -o json');
    const remaining = JSON.parse(raw);
    console.log(`  ${Array.isArray(remaining) ? remaining.length : '?'} user(s) remaining`);
  } catch (e) {
    console.log(`  could not re-list: ${e.message}`);
  }

  console.log('\nFresh start complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });