import pg from 'pg';

const { Pool } = pg;
let pool;

/** Server-only Neon connection. Never expose DATABASE_URL through VITE_*. */
export function neonPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for server-side Neon database access.');
  }
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  return pool;
}
