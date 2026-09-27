require('dotenv').config({ path: '.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED });
(async () => {
  try {
    const r = await pool.query(`
      select
        p.id as profile_id, p.email, p.role,
        m.business_id, m.role as member_role,
        b.business_name, b.owner_name, b.track_inventory,
        nu.id::text as neon_auth_user_id, nu.email as neon_email
      from public.profiles p
      left join public.business_memberships m on m.user_id = p.id
      left join public.businesses b on b.id = m.business_id
      left join neon_auth."user" nu on nu.id::text = p.id::text
      order by p.created_at desc
      limit 20
    `);
    console.log(JSON.stringify(r.rows, null, 2));
    const c = await pool.query('select count(*) from public.profiles');
    console.log('profiles count:', c.rows[0].count);
    const ac = await pool.query('select count(*) from neon_auth."user"');
    console.log('neon_auth.user count:', ac.rows[0].count);
    const all = await pool.query('select id::text, email from neon_auth."user" order by created_at desc limit 5');
    console.log('neon users:', all.rows);
  } catch (e) { console.error('ERR', e.message); }
  await pool.end();
})();