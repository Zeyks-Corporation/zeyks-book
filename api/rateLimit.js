import { createHash } from 'node:crypto';
import { neonPool } from '../server/neonDb.js';

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 5;
const MAX_LOCAL_KEYS = 5_000;
const localWindows = new Map();
let cleanupCounter = 0;

function callerIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return ip || req.socket?.remoteAddress || 'unknown';
}

function allowLocal(ipHash, now) {
  const current = (localWindows.get(ipHash) ?? []).filter((time) => now - time < WINDOW_MS);
  if (current.length >= MAX_REQUESTS) {
    localWindows.set(ipHash, current);
    return false;
  }
  current.push(now);
  localWindows.set(ipHash, current);
  if (localWindows.size > MAX_LOCAL_KEYS) {
    for (const [key, times] of localWindows) {
      if (!times.some((time) => now - time < WINDOW_MS)) localWindows.delete(key);
      if (localWindows.size <= MAX_LOCAL_KEYS) break;
    }
  }
  return true;
}

/** Shared Neon-backed contact throttling, atomic across Vercel instances. */
export async function allowContactRequest(req, now = Date.now()) {
  const ipHash = createHash('sha256').update(callerIp(req)).digest('hex');
  let db;
  try {
    db = neonPool();
  } catch (error) {
    // Never send real mail without the shared rate limiter. Simulation mode
    // may use a bounded process-local limiter because it sends no email.
    if (process.env.VERCEL && process.env.RESEND_API_KEY) throw error;
    return allowLocal(ipHash, now);
  }

  const slot = Math.floor(now / WINDOW_MS);
  const windowStart = new Date(slot * WINDOW_MS);
  const expiresAt = new Date((slot + 2) * WINDOW_MS);
  const result = await db.query(
    `insert into public.api_rate_limits (ip_hash, window_start, request_count, expires_at)
     values ($1, $2, 1, $3)
     on conflict (ip_hash, window_start) do update
       set request_count = public.api_rate_limits.request_count + 1
       where public.api_rate_limits.request_count < $4
     returning request_count`,
    [ipHash, windowStart, expiresAt, MAX_REQUESTS],
  );

  cleanupCounter += 1;
  if (cleanupCounter % 64 === 0) {
    void db.query('delete from public.api_rate_limits where expires_at <= now()').catch(() => {});
  }
  return result.rowCount === 1;
}
