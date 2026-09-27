require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
(async () => {
  try {
    const r = await pool.query(`
      select
        n.nspname,
        c.relname,
        c.relkind,
        c.relrowsecurity as rls,
        has_table_privilege('authenticated', c.oid, 'SELECT') as sel,
        has_table_privilege('authenticated', c.oid, 'INSERT') as ins,
        has_table_privilege('authenticated', c.oid, 'UPDATE') as upd,
        has_table_privilege('authenticated', c.oid, 'DELETE') as del
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'v')
        and c.relname in ('inventory_items','inventory_movements','inventory_stock_value',
                          'businesses','business_memberships','profiles','accounts',
                          'customers','suppliers','sales','sale_items','purchases','purchase_items',
                          'expenses','expense_items','payments','journal_entries','journal_lines',
                          'gateway_transactions','auth_otp_challenges')
      order by c.relname
    `);
    console.table(r.rows.map(x => ({
      table: x.relname,
      kind: x.relkind === 'v' ? 'view' : 'table',
      rls: x.rls,
      sel: x.sel,
      ins: x.ins,
      upd: x.upd,
      del: x.del,
    })));

    const pol = await pool.query(`
      select tablename, policyname, cmd, roles, qual
      from pg_policies
      where schemaname = 'public'
        and tablename like 'inventory%'
      order by tablename, policyname
    `);
    console.log('\nINVENTORY POLICIES:');
    console.table(pol.rows);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();