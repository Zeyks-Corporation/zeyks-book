import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, LogOut } from 'lucide-react';
import { supabase } from '../lib/neon';
import { ALL_ROLES, ROLE_LABEL, type AppRole } from '../lib/roles';
import { Button, Callout } from './ui';

/**
 * Hidden admin panel — reachable only at `/king`.
 *
 * There is intentionally no link from anywhere else in the app; the route
 * itself 404s for non-admins (see App.tsx). What this panel does:
 *
 *   * Lists every profile (id, email, full_name, role, created_at).
 *   * Lets an admin promote or demote a profile with a single click.
 *   * Confirms via the database (set_user_role) — never trusts the UI.
 *   * Lets the admin sign out from here if they need to.
 *
 * The 'admin' role on another profile is grantable, but an admin should not
 * leave admin grants lying around. There is no other destructive action here.
 */
interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: AppRole;
  created_at: string;
}

export const KingPanel: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignOut: () => void;
}> = ({ navigate, onSignOut }) => {
  const [rows, setRows] = useState<ProfileRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: e } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, created_at')
        .order('created_at', { ascending: true });
      if (e) {
        setError(e.message);
        setRows([]);
      } else {
        const list = (data ?? []) as ProfileRow[];
        list.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
        setRows(list);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load users.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setRole = useCallback(async (userId: string, nextRole: AppRole) => {
    setBusyId(userId);
    setError(null);
    try {
      const { error: e } = await supabase.rpc('set_user_role', {
        p_user_id: userId,
        p_role: nextRole,
      });
      if (e) {
        setError(e.message);
        return;
      }
      setRows((prev) =>
        prev ? prev.map((r) => (r.id === userId ? { ...r, role: nextRole } : r)) : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Role change failed.');
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <div className="min-h-screen bg-[var(--bg-secondary)]">
      <header className="h-14 border-b border-[var(--separator)] bg-[var(--bg)] sticky top-0 z-20 flex items-center gap-3 px-4">
        <ShieldCheck size={18} strokeWidth={1.8} className="text-[var(--accent)]" aria-hidden="true" />
        <h1 className="text-[17px] leading-[22px] font-semibold text-[var(--label)] grow">
          Admin panel
        </h1>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--label)] hover:bg-[var(--fill-secondary)] transition disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCw size={13} strokeWidth={1.8} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          <span>Refresh</span>
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--label)] hover:bg-[var(--fill-secondary)] transition"
        >
          <LogOut size={13} strokeWidth={1.8} aria-hidden="true" />
          <span>Sign out</span>
        </button>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 sm:px-6">
        <div className="bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6 shadow-sm">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            Zeyks Book staff
          </p>
          <h2 className="mt-2 text-[22px] font-bold leading-[28px] tracking-[-0.2px] text-[var(--label)]">
            User management
          </h2>
          <p className="mt-2 text-[14px] leading-[20px] text-[var(--label-secondary)]">
            Promote a user to a paying tier, demote them back to a free account,
            or grant staff access. Changes take effect the next time the user
            loads the app.
          </p>
        </div>

        {error && (
          <div className="mt-6">
            <Callout tone="error">{error}</Callout>
          </div>
        )}

        <div className="mt-6 bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-[14px] min-w-[640px]">
            <thead>
              <tr className="text-left text-[12px] uppercase tracking-[0.08em] text-[var(--label-tertiary)] border-b border-[var(--separator)] bg-[var(--fill-secondary)]">
                <th className="px-4 py-3 font-semibold">Email</th>
                <th className="px-4 py-3 font-semibold">Name</th>
                <th className="px-4 py-3 font-semibold">Joined</th>
                <th className="px-4 py-3 font-semibold">Current</th>
                <th className="px-4 py-3 font-semibold">Set role</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-[var(--label-secondary)]">Loading…</td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-[var(--label-secondary)]">No profiles yet.</td>
                </tr>
              )}
              {rows?.map((r) => (
                <tr key={r.id} className="border-b border-[var(--separator)] last:border-b-0">
                  <td className="px-4 py-3 font-medium text-[var(--label)]">{r.email || '—'}</td>
                  <td className="px-4 py-3 text-[var(--label-secondary)]">{r.full_name || '—'}</td>
                  <td className="px-4 py-3 text-[var(--label-tertiary)] tabular-nums">
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <RoleBadge role={r.role} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {ALL_ROLES.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          disabled={busyId === r.id || opt === r.role}
                          onClick={() => void setRole(r.id, opt)}
                          className={`text-[12px] font-medium rounded-full px-2.5 py-1 border transition disabled:cursor-not-allowed ${
                            opt === r.role
                              ? 'border-[var(--separator)] text-[var(--label-tertiary)] bg-[var(--fill-secondary)]'
                              : 'border-[var(--separator)] text-[var(--label)] hover:bg-[var(--fill-secondary)]'
                          } disabled:opacity-50`}
                        >
                          {ROLE_LABEL[opt]}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <div className="mt-8 flex justify-center">
          <Button variant="secondary" onClick={() => navigate('/')}>
            Back to website
          </Button>
        </div>
      </main>
    </div>
  );
};

const RoleBadge: React.FC<{ role: AppRole }> = ({ role }) => {
  const tone = (() => {
    switch (role) {
      case 'admin': return 'bg-purple-100 text-purple-700';
      case 'premium': return 'bg-[var(--accent)]/10 text-[var(--accent)]';
      case 'plus': return 'bg-amber-100 text-amber-700';
      default: return 'bg-[var(--fill-secondary)] text-[var(--label-secondary)]';
    }
  })();
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold ${tone}`}>
      {ROLE_LABEL[role]}
    </span>
  );
};