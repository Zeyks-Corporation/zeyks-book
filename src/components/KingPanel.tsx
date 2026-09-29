import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, RefreshCw, LogOut, Copy, Dice5 } from 'lucide-react';
import { supabase, createAuthUser } from '../lib/neon';
import { ALL_ROLES, ROLE_LABEL, type AppRole } from '../lib/roles';
import { Button, Callout, Field, inputClass } from './ui';

/**
 * Hidden admin panel — reachable only at `/king`.
 *
 * There is intentionally no link from anywhere else in the app; the route
 * itself 404s for non-admins (see App.tsx). What this panel does:
 *
 *   * Creates a customer: an email + password login in Neon Auth, plus the
 *     `profiles` row that carries their plan (`create_managed_user`).
 *   * Lists every profile (id, email, full_name, role, created_at).
 *   * Lets an admin promote or demote a profile with a single click.
 *   * Confirms via the database (set_user_role) — never trusts the UI.
 *   * Lets the admin sign out from here if they need to.
 *
 * There is no self sign-up anywhere in the product, so this is the only door a
 * new account comes through. The 'admin' role on another profile is grantable,
 * but an admin should not leave admin grants lying around; a new admin can
 * change plans here yet still cannot create accounts, because the sign-in
 * service keeps its own admin role separate from this one.
 */
interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  role: AppRole;
  created_at: string;
}

/** Readable, no look-alikes: I O 0 1 l are left out on purpose. */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const body = Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
  return `zeyks-${body}!`;
}

/** The one text an admin sends to a customer, in the shape they can paste. */
function credentialNote(email: string, password: string): string {
  return `Zeyks Book — sign in at https://www.zeyksbook.app\nEmail: ${email}\nPassword: ${password}`;
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

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState(() => generatePassword());
  const [newRole, setNewRole] = useState<AppRole>('user');
  const [creating, setCreating] = useState(false);
  /** The credentials just issued, shown once so the admin can hand them over. */
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  /**
   * Issue an account: the login in Neon Auth, then the app-side profile.
   *
   * Two services, so the two halves can fail apart. If the login is created and
   * the profile is not, the person can still sign in — their first sign-in then
   * claims a plain 'user' profile — so the honest report names the half that
   * failed and points at the plan buttons below rather than pretending nothing
   * happened.
   */
  const addUser = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const email = newEmail.trim().toLowerCase();
    const name = newName.trim();
    setError(null);
    setIssued(null);
    setCopied(false);
    if (!email || !name) {
      setError('Enter the account holder’s name and email address.');
      return;
    }
    if (newPassword.length < 8) {
      setError('The password needs at least 8 characters.');
      return;
    }
    setCreating(true);
    try {
      const created = await createAuthUser({ email, name, password: newPassword });
      if (!created.id) {
        setError(created.error);
        return;
      }
      const { error: profileError } = await supabase.rpc('create_managed_user', {
        p_auth_id: created.id,
        p_email: email,
        p_full_name: name,
        p_role: newRole,
      });
      if (profileError) {
        setError(`The sign-in works, but the app account was not created: ${profileError.message} They can still sign in — set their plan from the list below.`);
        void load();
        return;
      }
      setIssued({ email, password: newPassword });
      setNewName('');
      setNewEmail('');
      setNewRole('user');
      setNewPassword(generatePassword());
      void load();
    } finally {
      setCreating(false);
    }
  }, [load, newEmail, newName, newPassword, newRole]);

  const copyIssued = useCallback(async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(credentialNote(issued.email, issued.password));
      setCopied(true);
    } catch {
      setError('The browser would not let this page copy. Select the text and copy it by hand.');
    }
  }, [issued]);

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

        {/* ── Add a user ─────────────────────────────────────────────────── */}
        <div className="mt-6 bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] p-6">
          <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
            New account
          </p>
          <h2 className="mt-2 text-[22px] font-bold leading-[28px] tracking-[-0.2px] text-[var(--label)]">
            Add a user
          </h2>
          <p className="mt-2 text-[14px] leading-[20px] text-[var(--label-secondary)]">
            Nobody signs up by themselves. Create the login here, then send the
            email and password over — the business sets its own books up the
            first time it signs in.
          </p>

          <form onSubmit={addUser} className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Account holder" required>
              {(id) => (
                <input
                  id={id}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className={inputClass}
                  placeholder="Shop name or person"
                  autoComplete="off"
                />
              )}
            </Field>

            <Field label="Email — their sign-in" required>
              {(id) => (
                <input
                  id={id}
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className={inputClass}
                  placeholder="business@example.com"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>

            <Field label="Password" required hint="At least 8 characters. Generate one worth handing over.">
              {(id) => (
                <div className="flex gap-2">
                  <input
                    id={id}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={`${inputClass} grow`}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setNewPassword(generatePassword())}
                    aria-label="Generate a password"
                    title="Generate a password"
                    className="inline-flex items-center justify-center rounded-[10px] border border-[var(--separator)] bg-[var(--bg)] px-3 text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)] transition shrink-0 min-h-[44px]"
                  >
                    <Dice5 size={16} strokeWidth={1.8} aria-hidden="true" />
                  </button>
                </div>
              )}
            </Field>

            <div className="space-y-1.5">
              <span className="block text-[13px] leading-[18px] font-medium text-[var(--label-secondary)]">
                Plan
              </span>
              <div className="flex flex-wrap gap-1">
                {ALL_ROLES.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setNewRole(opt)}
                    aria-pressed={newRole === opt}
                    className={`text-[13px] font-medium rounded-full px-3 py-1.5 border transition ${
                      newRole === opt
                        ? 'border-[var(--accent)] text-white bg-[var(--accent)]'
                        : 'border-[var(--separator)] text-[var(--label)] hover:bg-[var(--fill-secondary)]'
                    }`}
                  >
                    {ROLE_LABEL[opt]}
                  </button>
                ))}
              </div>
              <p className="text-[13px] text-[var(--label-tertiary)]">
                Change or cancel it later from the list below.
              </p>
            </div>

            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" disabled={creating}>
                {creating ? 'Creating…' : 'Create account'}
              </Button>
            </div>
          </form>

          {issued && (
            <div className="mt-5">
              <Callout tone="info">
                <div className="space-y-2">
                  <p className="font-medium text-[var(--label)]">
                    Account created for {issued.email}. Send these details to them:
                  </p>
                  <pre className="whitespace-pre-wrap break-all rounded-[10px] bg-[var(--bg)] border border-[var(--separator)] px-3 py-2 text-[12px] leading-[18px] font-mono">
                    {credentialNote(issued.email, issued.password)}
                  </pre>
                  <button
                    type="button"
                    onClick={() => void copyIssued()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--bg)] px-3 py-1.5 text-[13px] font-medium text-[var(--label)] hover:bg-[var(--fill-secondary)] transition"
                  >
                    <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                    <span>{copied ? 'Copied' : 'Copy details'}</span>
                  </button>
                </div>
              </Callout>
            </div>
          )}
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