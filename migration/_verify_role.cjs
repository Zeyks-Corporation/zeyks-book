require('dotenv').config();
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const q = async (sql, label) => {
    const r = await c.query(sql);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(r.rows, null, 2));
  };
  await q(`select column_name, data_type, is_nullable, column_default
             from information_schema.columns
            where table_schema='public' and table_name='profiles'
            order by ordinal_position`, 'profiles columns');
  await q(`select proname, prosecdef, prorettype::regtype as returns
             from pg_proc p join pg_namespace n on n.oid=p.pronamespace
            where n.nspname='public' and proname in ('claim_profile','is_app_admin','set_user_role')`, 'new functions');
  await q(`select policyname, cmd, roles from pg_policies
            where schemaname='public' and tablename='profiles'`, 'profile policies');
  await q(`select grantee, privilege_type from information_schema.role_table_grants
            where table_schema='public' and table_name='profiles'
              and grantee in ('anon','authenticated')
            order by grantee, privilege_type`, 'profile grants to client roles');
  await q(`select id::text, email, role from public.profiles order by created_at limit 20`, 'profile rows');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });