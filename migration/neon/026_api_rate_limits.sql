-- Shared, server-side rate limiting for public API endpoints.
-- Apply after 025_database_access.sql. Browser roles cannot read or write this table.

create table if not exists public.api_rate_limits (
  ip_hash       text        not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  window_start  timestamptz not null,
  request_count smallint    not null check (request_count between 1 and 5),
  expires_at    timestamptz not null,
  primary key (ip_hash, window_start)
);

create index if not exists api_rate_limits_expiry_idx
  on public.api_rate_limits (expires_at);

alter table public.api_rate_limits enable row level security;
revoke all on table public.api_rate_limits from public, anon, authenticated;

comment on table public.api_rate_limits is
  'Server-only short-window IP rate-limit counters. Expired rows are pruned by the API.';
