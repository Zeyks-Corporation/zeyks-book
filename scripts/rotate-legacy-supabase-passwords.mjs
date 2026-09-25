/**
 * One-time incident response for passwords assigned by the old session bridge.
 * Run after rotating the exposed Supabase service-role key. No user identifiers
 * or credentials are printed. This app signs users in through Firebase.
 *
 * Usage: node scripts/rotate-legacy-supabase-passwords.mjs
 *        node scripts/rotate-legacy-supabase-passwords.mjs --apply
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const apply = process.argv.includes('--apply');

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
const userIds = [];
while (true) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
  if (error) throw error;
  userIds.push(...data.users.map((user) => user.id));
  if (data.users.length < 100) break;
  page += 1;
}

if (!apply) {
  console.log(`Dry run: ${userIds.length} Supabase Auth accounts would receive random passwords. Pass --apply after reviewing this scope.`);
  process.exit(0);
}

let rotated = 0;
for (const userId of userIds) {
  const { error } = await admin.auth.admin.updateUserById(userId, {
    password: randomBytes(48).toString('base64url'),
  });
  if (error) throw new Error(`Password rotation stopped after ${rotated} accounts: ${error.message}`);
  rotated += 1;
}
console.log(`Rotated passwords for ${rotated} Supabase Auth accounts.`);
