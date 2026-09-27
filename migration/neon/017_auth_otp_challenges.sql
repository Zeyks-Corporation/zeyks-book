-- 017_auth_otp_challenges.sql
-- Email verification codes (OTP), owned by the API server.
--
-- Sign-in is: the server emails a six-digit code, the person types it back, and
-- the server exchanges the verified code for a Supabase session. That needs
-- somewhere to keep the code between the two requests — somewhere that outlives
-- a restarted process (a deployment runs many short-lived instances) and that
-- no client can read.
--
-- Model
--   * One row per issued code. The code itself is never stored: the column is an
--     HMAC-SHA256 hash keyed by a server secret, because a six-digit code is
--     trivial to brute-force against a bare hash dump.
--   * Rows are single-use. `consumed_at` is set the moment a code is verified,
--     expires, or runs out of attempts, and no later request may reuse it.
--   * The request IP is stored as a hash as well; it exists only so the *send*
--     rate can be limited per network.
--   * No client role has any privilege on this table — RLS is enabled with no
--     policy at all, and every grant is revoked from anon and authenticated.
--     Only the server's secret key (which bypasses RLS) touches it.
--   * Expired rows are deleted by the server as it works, so the table stays
--     bounded without a scheduler.

create table public.auth_otp_challenges (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,
  full_name text,
  request_ip_hash text,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_reason text
);

comment on table public.auth_otp_challenges is
  'Server-only email OTP challenges. Read and written exclusively by the API server through the secret key; no client role holds any privilege on it, and RLS has no policy.';

alter table public.auth_otp_challenges enable row level security;

-- The same shape 001/002 use: revoke everything, grant nothing. There is
-- deliberately no policy, so even an accidental grant would return zero rows.
revoke all on public.auth_otp_challenges from public, anon, authenticated;

create index auth_otp_challenges_email_idx
  on public.auth_otp_challenges (email, created_at desc);
create index auth_otp_challenges_ip_idx
  on public.auth_otp_challenges (request_ip_hash, created_at desc);
create index auth_otp_challenges_expiry_idx
  on public.auth_otp_challenges (expires_at);

-- Safety net: prove the boundary holds.
do $$
declare
  v_leak text;
begin
  select string_agg(g.privilege_type, ', ') into v_leak
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name = 'auth_otp_challenges'
     and g.grantee in ('anon', 'authenticated');
  if v_leak is not null then
    raise exception 'auth_otp_challenges must grant nothing to client roles, found: %', v_leak;
  end if;
end $$;
