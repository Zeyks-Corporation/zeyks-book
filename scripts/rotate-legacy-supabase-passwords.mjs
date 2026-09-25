/**
 * One-time incident response for passwords assigned by the old session bridge.
 * Run after rotating the exposed Supabase service-role key. No user identifiers
 * or credentials are printed. This app signs users in through Firebase.
 *
 * Usage: node scripts/rotate-legacy-supabase-passwords.mjs --apply
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

if (!process.argv.includes('--apply')) {
  console.error('No changes made. Pass --apply to rotate all Supabase Auth passwords.');
  process.exit(1);
}

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the server environment.');
  process.exit(1);
}

const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let page = 1;
let rotated = 0;
while (true) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  for (const user of data.users) {
    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password: randomBytes(48).toString('base64url'),
    });
    if (updateError) throw new Error(`Password rotation stopped after ${rotated} accounts: ${updateError.message}`);
    rotated += 1;
  }
  if (data.users.length < 100) break;
  page += 1;
}
console.log(`Rotated passwords for ${rotated} Supabase Auth accounts.`);
