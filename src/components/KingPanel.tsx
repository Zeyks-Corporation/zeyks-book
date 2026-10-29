import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, LogOut } from 'lucide-react';
import { supabase } from '../lib/neon';
import { ROLE_LABEL, type AppRole } from '../lib/roles';
import { Button, Callout } from './ui';

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: AppRole;
  is_staff: boolean;
  created_at: string;
}

/** Hidden, read-only staff directory. Plans and staff access are set in Neon. */
export const KingPanel: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignOut: () => void;
}> = ({ navigate, onSignOut }) => {
  const [rows, setRows] = useState<ProfileRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: loadError } = await supabase.from('profiles')
        .select('id, email, full_name, role, is_staff, created_at')
        .order('created_at', { ascending: true });
      if (loadError) throw new Error(loadError.message);
      setRows((data ?? []) as ProfileRow[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load users.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="min-h-screen bg-[var(--bg-secondary)]">
      <header className="h-14 border-b border-[var(--separator)] bg-[var(--bg)] sticky top-0 z-20 flex items-center gap-3 px-4">
        <ShieldCheck size={18} className="text-[var(--accent)]" aria-hidden="true" />
        <h1 className="text-[17px] font-semibold text-[var(--label)] grow">Admin panel</h1>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] px-3 py-1.5 text-[13px]">
          <RefreshCw size={13} aria-hidden="true" /> Refresh
        </button>
        <button type="button" onClick={onSignOut}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] px-3 py-1.5 text-[13px]">
          <LogOut size={13} aria-hidden="true" /> Sign out
        </button>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8 sm:px-6">
        <div className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6">
          <h2 className="text-[22px] font-bold text-[var(--label)]">Users</h2>
          <p className="mt-2 text-[14px] text-[var(--label-secondary)]">
            Customers sign in with Google. New accounts start locked. Assign Starter or Premium and staff access in Neon’s public.profiles table.
          </p>
        </div>
        {error && <div className="mt-6"><Callout tone="error">{error}</Callout></div>}
        <div className="mt-6 bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] overflow-x-auto">
          <table className="w-full text-[14px] min-w-[580px]">
            <thead><tr className="text-left text-[12px] uppercase text-[var(--label-tertiary)] border-b border-[var(--separator)]">
              <th className="px-4 py-3">Email</th><th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Joined</th><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Staff</th>
            </tr></thead>
            <tbody>
              {rows === null && <tr><td colSpan={5} className="px-4 py-6 text-center">Loading…</td></tr>}
              {rows?.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center">No profiles yet.</td></tr>}
              {rows?.map((row) => <tr key={row.id} className="border-b border-[var(--separator)] last:border-0">
                <td className="px-4 py-3 font-medium">{row.email}</td>
                <td className="px-4 py-3">{row.full_name || '—'}</td>
                <td className="px-4 py-3">{new Date(row.created_at).toLocaleDateString()}</td>
                <td className="px-4 py-3">{ROLE_LABEL[row.role] ?? 'Locked'}</td>
                <td className="px-4 py-3">{row.is_staff ? 'Yes' : 'No'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="mt-8 flex justify-center"><Button variant="secondary" onClick={() => navigate('/dashboard')}>Open books</Button></div>
      </main>
    </div>
  );
};
