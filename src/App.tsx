import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import { UserProfile, ViewTab } from './types';
import { useBooks } from './state/useBooks';
import { Sidebar, Header } from './components/Shell';
import { TransactionModal, TxnKind } from './components/TransactionModal';
import { CollectOnlineModal, resolvePending } from './components/CollectOnlineModal';
import { AuthModal } from './components/AuthModal';
import { Button, Callout, Field, inputClass } from './components/ui';
import { LandingPage } from './components/LandingPage';
import { PricingPage } from './components/PricingPage';
import { AboutPage } from './components/AboutPage';
import { ContactPage } from './components/ContactPage';
import { PrivacyPage } from './components/PrivacyPage';
import { TermsPage } from './components/TermsPage';
import { NotFoundView } from './components/NotFoundView';
import { IntentPageView } from './components/IntentPage';
import { SubscribeView } from './components/SubscribeView';
import { KingPanel } from './components/KingPanel';
import { isPayingTier, roleHasFeature, paywallHoldsAccount, type AppRole } from './lib/roles';
import { PlanLockedView } from './components/UpgradeViews';
import { gateway, GatewayConfig, takePending } from './services/paymentGateway';
import { useRoute } from './lib/useRoute';
import { parseRoute, pathForTab, redirectFor } from './lib/routes';
import { intentPageForPath } from './lib/intentPages';
import { TITLES, applyPageMetadata, metadataForPath } from './lib/pageMetadata';
import { readCalendarPreference, writeCalendarPreference } from './lib/preferences';
import type { CalendarPreference } from './lib/preferences';
import {
  PAYMENT_API_DISABLED_MESSAGE, onlineCollectionAvailable, paymentApiConfigured,
} from './lib/paymentApi';
import { todayNpt } from './lib/nepaliDate';
import * as authService from './services/authService';
import * as businessService from './services/businessService';
import {
  resolveAppPhase, resolveAuthEvent, selectActiveMembership, membershipsOwnedBy,
} from './lib/appPhases';
import type {
  AuthAction, DataState, MembershipState, SessionPhase,
} from './lib/appPhases';
import { CAPABILITIES, isSupported, unsupportedMessage } from './lib/capabilities';
import type { Capability } from './lib/capabilities';
import { isCurrentEpoch, nextEpoch } from './lib/session';
import type { SignOutKind } from './lib/session';
import { isBrowserOnline, useOnlineStatus } from './lib/connectivity';
import {
  cacheOfflineSession, clearOfflineStore, readOfflineSession,
} from './lib/offlineStore';

// Keep charting and demo-only code out of the first page download. These
// screens are fetched only when a user opens that part of the app.
const DashboardView = lazy(() => import('./components/DashboardView').then((m) => ({ default: m.DashboardView })));
const DocumentsView = lazy(() => import('./components/DocumentsView').then((m) => ({ default: m.DocumentsView })));
const ReportsView = lazy(() => import('./components/ReportsView').then((m) => ({ default: m.ReportsView })));
const HealthView = lazy(() => import('./components/HealthView').then((m) => ({ default: m.HealthView })));
const SettingsView = lazy(() => import('./components/SettingsView').then((m) => ({ default: m.SettingsView })));
const DemoPage = lazy(() => import('./components/DemoPage').then((m) => ({ default: m.DemoPage })));
const InventoryView = lazy(() => import('./components/InventoryView').then((m) => ({ default: m.InventoryView })));

/** Which capability each transaction kind needs before it can be recorded. */
const CAPABILITY_FOR_TXN: Record<TxnKind, Capability> = {
  sale: 'sales', purchase: 'purchases', expense: 'expenses', payment: 'payments',
};

const TXN_LABELS: Record<TxnKind, string> = {
  sale: 'Recording a sale', purchase: 'Recording a purchase',
  expense: 'Recording an expense', payment: 'Recording a settlement',
};

function profileFromAuthUser(authUser: { id: string; email?: string | null; name?: string | null; createdAt?: string }): UserProfile {
  const email = authUser.email ?? '';
  return {
    id: authUser.id,
    email,
    fullName: authUser.name || email.split('@')[0] || '',
    // No profiles row was readable, so default to the locked role. The very
    // next profile refresh (e.g. from the admin panel or after sign-in) will
    // overwrite this with the real role.
    appRole: 'user',
    createdAt: authUser.createdAt ?? new Date().toISOString(),
  };
}

/** First-run business setup, shown once before the app is usable. */
const OnboardingGate: React.FC<{
  onComplete: (name: string, owner: string) => Promise<void>;
  busy?: boolean;
  error?: string | null;
}> = ({ onComplete, busy, error }) => {
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');
  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] shadow-sm p-6 space-y-4">
        <div>
          <h1 className="text-[17px] leading-[22px] font-semibold text-[var(--label)]">Set up your books</h1>
          <p className="text-[15px] leading-[20px] text-[var(--label-secondary)] mt-1">This only takes a moment. You can change any of it later in Settings.</p>
        </div>
        {error && <Callout tone="error">{error}</Callout>}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !busy) void onComplete(name.trim(), owner.trim());
          }}
        >
          <Field label="Business name" required>
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={name}
                autoFocus
                disabled={busy}
                placeholder="e.g. Himal Traders"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Owner's name">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={owner}
                disabled={busy}
                onChange={(e) => setOwner(e.target.value)}
              />
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            disabled={!name.trim() || busy}
          >
            {busy ? 'Setting up…' : 'Start'}
          </Button>
        </form>
      </div>
    </div>
  );
};

const LoadingScreen: React.FC<{ message: string }> = ({ message }) => (
  <div className="min-h-screen bg-[var(--bg-secondary)] flex items-center justify-center p-4">
    <div className="flex flex-col items-center gap-3">
      <div className="w-8 h-8 border-2 border-[var(--separator-opaque)] border-t-[var(--accent)] rounded-full animate-spin" />
      <p className="text-[15px] leading-[20px] text-[var(--label-secondary)]">{message}</p>
    </div>
  </div>
);

/** A distinct error state: checking failed, so we must NOT offer onboarding. */
const ErrorScreen: React.FC<{
  title: string;
  message: string;
  busy?: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}> = ({ title, message, busy, onRetry, onSignOut }) => (
  <div className="min-h-screen bg-[var(--bg-secondary)] flex items-center justify-center p-4">
    <div className="w-full max-w-sm bg-[var(--bg)] border border-[var(--separator)] rounded-[14px] shadow-sm p-6 space-y-4">
      <h1 className="text-[17px] leading-[22px] font-semibold text-[var(--label)]">{title}</h1>
      <Callout tone="error">{message}</Callout>
      <div className="flex justify-between items-center pt-2">
        <Button variant="secondary" onClick={onSignOut}>Sign out</Button>
        <Button variant="primary" onClick={onRetry} disabled={busy}>
          {busy ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </div>
  </div>
);

const Toast: React.FC<{ message: string; ok: boolean; onDismiss: () => void }> = ({ message, ok, onDismiss }) => {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, 4500);
    return () => window.clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 rounded-full border px-5 py-3 text-[13px] leading-[18px] shadow-lg max-w-sm ${
        ok ? 'bg-[var(--bg-tertiary)] border-[var(--separator)] text-[var(--label)]' : 'bg-[var(--destructive)] border-[var(--destructive)] text-white'
      }`}
    >
      {ok ? <CheckCircle2 size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" /> : <XCircle size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />}
      <span>{message}</span>
    </div>
  );
};

export default function App() {
  const books = useBooks();
  const {
    user, setUser, business, setBusiness, defaultRange, integrityIssues, storageError,
    loadFromCloud, resetAll,
    offline, offlineSavedAt, loadFromOffline,
  } = books;

  /* ------------------------------ auth state ------------------------------ */

  const [sessionPhase, setSessionPhase] = useState<SessionPhase>('checking-session');
  const [membership, setMembership] = useState<MembershipState>({ kind: 'pending' });
  const [dataState, setDataState] = useState<DataState>({ kind: 'idle' });
  const [authEvent, setAuthEvent] = useState<{ action: AuthAction; session: { user: { id: string; email: string } } | null; key: number } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /**
   * Shown on the sign-in screen, because the toast only renders inside the
   * signed-in app. Used when a sign-out ended this device's session but could
   * not revoke the other devices. Cleared as soon as a new session starts.
   */
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  /**
   * Monotonic session epoch.
   *
   * Bumped whenever the local session is cleared. A book load records the epoch
   * it started in and is dropped once the epoch moves, so a fetch that was
   * already in flight at sign-out can never repopulate the books of the person
   * who just left.
   */
  const sessionEpoch = useRef(0);

  /**
   * Refs for the values the cloud-load callback needs but must not depend on:
   * the load is triggered by auth events and retries, and re-creating it when
   * the profile or business changes would re-trigger effects that hold it.
   */
  const userRef = useRef<UserProfile | null>(user);
  useEffect(() => { userRef.current = user; }, [user]);
  const lastBusinessIdRef = useRef<string | null>(null);

  /**
   * Write the signed-in profile, keeping the ref in step with the state.
   *
   * The `useEffect` mirror above runs one render late, and the cloud load reads
   * the ref immediately after sign-in — a lagging ref would label one person's
   * books with the previous person's profile. Assigning here closes that gap.
   */
  const applyUser = useCallback((next: UserProfile | null) => {
    userRef.current = next;
    setUser(next);
  }, [setUser]);

  /**
   * The user id the on-screen books belong to.
   *
   * Signing in as another account can be a switch, not a sign-out: no SIGNED_OUT
   * event arrives, so the epoch never moves and the previous person's rows are
   * still in state. Comparing ids is what makes that switch visible to the app.
   */
  const sessionOwnerRef = useRef<string | null>(null);

  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);

  /**
   * The screen IS the address bar.
   *
   * `path` is the URL's pathname and `route` is what that path means, so a
   * hard refresh, the back button, a pasted link and the sidebar all resolve
   * to the same screen. Nothing else may set the current screen — there is no
   * second copy of "where am I" that could disagree with the URL.
   */
  const { path, navigate } = useRoute();
  const route = useMemo(() => parseRoute(path), [path]);

  // The document's title, description and canonical URL follow the route, so
  // each public page describes itself instead of all of them claiming the home
  // page. Signed-in screens are marked noindex here as well as in robots.txt.
  useEffect(() => {
    applyPageMetadata(metadataForPath(path));
  }, [path]);
  const [range, setRange] = useState(defaultRange);
  const [rangeTouched, setRangeTouched] = useState(false);
  /**
   * Which calendar dates are written in. A reading preference, kept on this
   * device (see lib/preferences.ts) and changed from Settings · Currency & date
   * rather than from the top bar.
   */
  const [calendar, setCalendar] = useState<CalendarPreference>(() => readCalendarPreference());
  const changeCalendar = useCallback((next: CalendarPreference) => {
    setCalendar(next);
    writeCalendarPreference(next);
  }, []);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Any in-app navigation closes the mobile drawer so the new screen isn't
  // half-covered. The hamburger open-button sets it back to true.
  useEffect(() => { setMobileSidebarOpen(false); }, [path]);
  const [toast, setToast] = useState<{ message: string; ok: boolean; key: number } | null>(null);

  const [txnModal, setTxnModal] = useState<TxnKind | null>(null);
  /**
   * The document a settlement modal was opened for, when it came from a row:
   * a bill (money out) or an invoice (a manual receipt, money in). The direction
   * is the document's, not the caller's choice.
   */
  const [settleFor, setSettleFor] = useState<
    { documentId: string; direction: 'INCOMING' | 'OUTGOING' } | undefined
  >(undefined);
  const [collectFor, setCollectFor] = useState<string | undefined>(undefined);
  const [collectOpen, setCollectOpen] = useState(false);

  const [gatewayConfig, setGatewayConfig] = useState<GatewayConfig | null>(null);

  /**
   * Cloud startup chain, in order:
   *   memberships -> selected business -> fetchAllBookData.
   * Nothing here consults browser-local state, so PC and phone resolve the
   * same membership for the same signed-in user.
   *
   * `expectedUserId` is the identity this load is allowed to write state for.
   * Every await is followed by a check that this person is still the signed-in
   * one, so a load that started for account A cannot finish under account B.
   */
  const loadUserBusinessAndData = useCallback(async (
    expectedUserId?: string | null,
  ) => {
    // Recorded once per load. If the session ends while this is running, every
    // write below is abandoned instead of landing in the cleared state.
    const startedAt = sessionEpoch.current;
    const owner = expectedUserId !== undefined ? expectedUserId : (userRef.current?.id ?? null);
    const stillCurrent = () =>
      isCurrentEpoch(sessionEpoch.current, startedAt)
      && (owner === null || sessionOwnerRef.current === owner);

    setMembership({ kind: 'pending' });
    setDataState({ kind: 'idle' });
    const signedInUser = owner ? (userRef.current?.id === owner ? userRef.current : null) : userRef.current;
    try {
      const { memberships: rawMemberships, error: memErr } = await businessService.getMyMemberships();
      if (!stillCurrent()) return;
      if (memErr) {
        // A failed lookup is NOT the same as having no business.
        setMembership({ kind: 'error', message: memErr });
        return;
      }
      // Rows carry their own user id, so a list answered with someone else's
      // token is detectable here rather than rendered as this person's books.
      const memberships = membershipsOwnedBy(rawMemberships, owner);
      if (owner && rawMemberships.length > 0 && memberships.length === 0) {
        // The data came back for a different account. Refuse to show it.
        setMembership({ kind: 'error', message: 'That data belongs to a different sign-in. Please reload.' });
        return;
      }
      if (memberships.length === 0) {
        setMembership({ kind: 'empty' });
        return;
      }

      setMembership({ kind: 'ready', memberships });
      const active = selectActiveMembership(memberships);
      if (!active) {
        setMembership({ kind: 'empty' });
        return;
      }

      setDataState({ kind: 'loading' });
      const { business: biz, error: bizErr } = await businessService.getBusiness(active.businessId);
      if (!stillCurrent()) return;
      if (bizErr || !biz) throw new Error(bizErr || 'Could not load business details.');
      setBusiness(biz);
      await loadFromCloud(active.businessId, stillCurrent);
      if (!stillCurrent()) return;
      setDataState({ kind: 'ready' });
      // Everything the offline view needs is now in sync with the server —
      // keep one copy in IndexedDB until the next successful load overwrites it.
      lastBusinessIdRef.current = active.businessId;
      if (signedInUser) void cacheOfflineSession(signedInUser, biz, memberships);
    } catch (e) {
      if (!stillCurrent()) return;
      const message = e instanceof Error ? e.message : 'Error loading business data.';
      // The network may simply be gone. Open the last synced copy instead of
      // an error screen; only a business that was never cached keeps the error.
      const bizId = lastBusinessIdRef.current;
      if (bizId && !isBrowserOnline()) {
        const restored = await loadFromOffline(bizId);
        if (!stillCurrent()) return;
        if (restored) {
          setDataState({ kind: 'ready' });
          return;
        }
      }
      setDataState({ kind: 'error', message });
    }
  }, [loadFromCloud, loadFromOffline, setBusiness]);

  /**
   * Open the app from the offline copy alone (Phase 1 of offline support).
   *
   * Only ever called while the browser reports no network, when the session
   * check could not reach the auth server. The restored view is read-only:
   * `loadFromOffline` flags the store `offline`, every write path refuses, and
   * the next real cloud load clears the flag. Returns whether books were shown.
   */
  const restoreOfflineSession = useCallback(async (): Promise<boolean> => {
    const record = await readOfflineSession();
    if (!record) return false;
    // A different person may have used this browser since the cache was written.
    if (sessionOwnerRef.current !== null && sessionOwnerRef.current !== record.userId) {
      void clearOfflineStore();
      return false;
    }
    const restored = await loadFromOffline(record.business.id);
    if (!restored) return false;
    applyUser(record.user);
    setBusiness(record.business);
    setMembership({ kind: 'ready', memberships: record.memberships });
    setDataState({ kind: 'ready' });
    setSessionPhase('authenticated');
    sessionOwnerRef.current = record.userId;
    lastBusinessIdRef.current = record.business.id;
    return true;
  }, [applyUser, loadFromOffline, setBusiness]);

  /**
   * Clear everything that belongs to the signed-out session.
   *
   * The epoch moves first, so any book load still in flight is dropped rather
   * than writing rows into the state this is about to empty. Idempotent: the
   * explicit sign-out path and the SIGNED_OUT event can both call it.
   */
  const clearLocalSession = useCallback(() => {
    sessionEpoch.current = nextEpoch(sessionEpoch.current);
    sessionOwnerRef.current = null;
    setSessionPhase('unauthenticated');
    setMembership({ kind: 'pending' });
    setDataState({ kind: 'idle' });
    applyUser(null);
    setProfileError(null);
    setResolving(false);
    // No open modal, draft or toast survives into the next session.
    setTxnModal(null);
    setSettleFor(undefined);
    setCollectOpen(false);
    setCollectFor(undefined);
    setToast(null);
    resetAll();
    lastBusinessIdRef.current = null;
    // The offline copy belongs to this session only. A signed-out person must
    // never be able to reopen someone else's books from the browser cache.
    void clearOfflineStore();
  }, [applyUser, resetAll]);

  // 1. Initial session check + subscribe. The auth callback is synchronous:
  //    it only records the event so network work never runs inside the lock.
  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | null = null;
    // Boot snapshot of the URL: the app restoration below must not re-run the
    // session check on in-app navigation, so only the primitive is captured.
    const bootOnAppRoute = route.kind === 'app';

    void (async () => {
      const { session, error: sessionError } = await authService.getSession();
      if (!mounted) return;
      if (sessionError) setSessionNotice(sessionError);
      // Subscribe after the one-use Google callback verifier has been exchanged.
      unsubscribe = authService.onAuthStateChange((event: string, nextSession) => {
        if (!mounted || event === 'INITIAL_SESSION') return;
        const action = resolveAuthEvent(event);
        if (action !== 'ignore') setAuthEvent({ action, session: nextSession, key: Date.now() });
      });
      if (!session?.user) {
        // The session check cannot outlive a missing network: the auth server
        // is unreachable too. Before showing the sign-in screen, reopen the
        // last synced books read-only if this device has them cached.
        if (bootOnAppRoute && !isBrowserOnline()) {
          if (await restoreOfflineSession()) return;
        }
        setSessionPhase('unauthenticated');
        applyUser(null);
        return;
      }
      setAuthEvent({ action: 'bootstrap', session, key: Date.now() });
    })();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, [applyUser, restoreOfflineSession, route.kind]);

  // 2. Deferred auth work — all network calls happen here, never in the callback.
  useEffect(() => {
    if (!authEvent) return;
    let cancelled = false;

    void (async () => {
      const { action, session } = authEvent;

      // The event is the safety net: if Neon ends the session by itself
      // (expiry, revocation elsewhere), the state is cleared the same way as it
      // is for a sign-out the person asked for.
      if (action === 'sign-out') {
        clearLocalSession();
        return;
      }

      // TOKEN_REFRESHED must not reload the whole book.
      if (action === 'token-only') return;

      if (!session?.user) {
        setSessionPhase('unauthenticated');
        applyUser(null);
        return;
      }

      const authUser = session.user;
      /**
       * Signing in as another account can be a switch, not a sign-out: no
       * SIGNED_OUT event arrives first, so the previous person's books are
       * still in state and any load they started is still in flight. Emptying
       * the session here — which also moves the epoch, dropping those loads —
       * is what stops one account's rows being shown under another's name.
       */
      if (sessionOwnerRef.current !== null && sessionOwnerRef.current !== authUser.id) {
        clearLocalSession();
      }
      sessionOwnerRef.current = authUser.id;

      setResolving(true);
      // A new session starts: any notice from the previous sign-out is spent.
      setSessionNotice(null);
      try {
        const { profile, error } = await authService.getProfile(authUser.id);
        if (cancelled || sessionOwnerRef.current !== authUser.id) return;
        if (error || !profile) {
          setProfileError(error || 'Could not load your account profile.');
          applyUser(profileFromAuthUser(authUser));
          setSessionPhase('authenticated');
          return;
        }
        setProfileError(null);
        applyUser(profile ?? profileFromAuthUser(authUser));
        setSessionPhase('authenticated');
        if (action === 'refresh-profile') return;
        await loadUserBusinessAndData(authUser.id);
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();

    return () => { cancelled = true; };
  }, [applyUser, authEvent, clearLocalSession, loadUserBusinessAndData]);

  // Plans are assigned in the database while a customer may already be signed
  // in. Refresh the profile when they return to the tab so a newly granted
  // Plus/Premium plan is reflected without requiring a fresh login.
  useEffect(() => {
    if (!user?.id) return;
    let inFlight = false;
    const refreshAccess = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const { profile } = await authService.getProfile(user.id);
        if (profile && sessionOwnerRef.current === user.id) {
          applyUser(profile);
        }
      } finally {
        inFlight = false;
      }
    };
    window.addEventListener('focus', refreshAccess);
    document.addEventListener('visibilitychange', refreshAccess);
    return () => {
      window.removeEventListener('focus', refreshAccess);
      document.removeEventListener('visibilitychange', refreshAccess);
    };
  }, [user?.id, applyUser]);

  // Once the person changes the period, stop silently resetting it to
  // "current fiscal year to date" every time the fiscal year setting loads.
  useEffect(() => { if (!rangeTouched) setRange(defaultRange); }, [defaultRange, rangeTouched]);
  const updateRange = useCallback((r: typeof range) => { setRange(r); setRangeTouched(true); }, []);

  /**
   * The network is back while the read-only offline copy is on screen.
   *
   * A full reload runs the normal boot chain, which re-hits the server and
   * clears the offline flag with live data. Anything the person tried to do
   * offline was refused, so there is nothing to reconcile and nothing lost.
   */
  const onlineNow = useOnlineStatus();
  useEffect(() => {
    if (offline && onlineNow) window.location.reload();
  }, [offline, onlineNow]);

  const notify = useCallback((message: string, ok: boolean) => {
    setToast({ message, ok, key: Date.now() });
  }, []);

  /**
   * Leave the signed-in session on purpose.
   *
   * `kind` decides the scope: `'this-device'` (the default) ends only this
   * device's session, `'everywhere'` also revokes the other devices'. State is
   * cleared only once the client confirms its stored session is really gone, so
   * a sign-out that failed reports itself rather than showing the auth screen
   * while a reload would restore the session.
   */
  const exitSession = useCallback(async (kind: SignOutKind) => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const { cleared, error } = await authService.signOut(kind);
      if (!cleared) {
        notify(error ?? 'Could not sign out on this device.', false);
        return;
      }
      clearLocalSession();
      // Signed out here, but the server-side revoke failed. The toast belongs to
      // the signed-in app, so this goes to the sign-in screen instead — the
      // person must know the other devices were not revoked.
      setSessionNotice(error);
    } finally {
      setSigningOut(false);
    }
  }, [clearLocalSession, notify, signingOut]);

  // Payment gateway availability, read from the API server that holds the
  // secrets (never from this bundle). The server has no credentials for a
  // provider it was not configured with, and the UI disables that provider.
  //
  // Read once a session exists: every route on that API authenticates the
  // caller, so before sign-in this answers 401 and the honest result is "no
  // gateway" — not a sandbox the person could not actually use.
  // Only ask when there is an API to ask: in a deployment that has not declared
  // one, the request would 404 on every load. `paymentApiConfigured()` is a
  // build-time fact, so an unconfigured deployment makes no call at all and the
  // gateway is simply not offered (see lib/paymentApi.ts).
  const signedInUserId = user?.id ?? null;
  useEffect(() => {
    // Nothing to read before a session exists: every route on that API answers
    // 401 without a token, and asking anyway put an unauthenticated request in
    // the console of the public landing page.
    if (!signedInUserId || !paymentApiConfigured()) { setGatewayConfig(null); return; }
    void gateway.config().then(setGatewayConfig);
  }, [signedInUserId]);

  // On return from eSewa/Khalti, confirm the payment with the server before
  // anything is written to the books: the API server asks the provider, then
  // settle_gateway_txn re-validates the answer against the collection.
  useEffect(() => {
    if (!isSupported('gateway')) return;
    const pending = takePending();
    if (!pending) return;
    void resolvePending(pending, books).then((result) => notify(result.message, result.ok));
    const url = new URL(window.location.href);
    if (url.searchParams.has('esewa') || url.searchParams.has('khalti') || url.searchParams.has('data')) {
      url.search = '';
      window.history.replaceState({}, '', url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSignedIn = useCallback((signedInUser: UserProfile) => {
    // Password sign-in resolves inside this tab, and the adapter's
    // onAuthStateChange only relays events from *other* tabs — so nothing would
    // ever load this person's books if the screen just waited for an event.
    // Recording the event runs the same guarded chain the boot read uses.
    applyUser(signedInUser);
    setSessionPhase('authenticated');
    setAuthEvent({
      action: 'reload-books',
      session: { user: { id: signedInUser.id, email: signedInUser.email } },
      key: Date.now(),
    });
  }, [applyUser]);

  const handleOnboardingComplete = useCallback(async (name: string, owner: string) => {
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const { business: createdBiz, error } = await businessService.createBusiness({
        businessName: name,
        ownerName: owner,
      });
      if (error || !createdBiz) {
        setOnboardingError(error || 'Failed to create business.');
        return;
      }
      // Re-resolve from the database rather than trusting local state.
      await loadUserBusinessAndData();
    } catch (err) {
      setOnboardingError(err instanceof Error ? err.message : 'Failed to create business.');
    } finally {
      setOnboardingBusy(false);
    }
  }, [loadUserBusinessAndData]);

  const openQuickAction = useCallback((kind: TxnKind) => {
    if (!isSupported(CAPABILITY_FOR_TXN[kind])) {
      notify(unsupportedMessage(TXN_LABELS[kind]), false);
      return;
    }
    setSettleFor(undefined);
    setTxnModal(kind);
  }, [notify]);

  /**
   * Settle one document from its own row: a receipt against an invoice (money
   * in) or a payment to a supplier against a bill (money out). It opens the one
   * settlement form, pre-filled with that document, its direction and the
   * balance the persisted rows say is outstanding — a convenience figure only:
   * `post_payment` locks the document, recomputes the balance from the
   * settlement rows and re-validates the amount, method and date server-side.
   *
   * This is deliberately separate from the gateway: "Record a receipt" records
   * money that already arrived by cash, bank or a wallet transfer; "Collect
   * online" creates a provider payment the customer completes on eSewa's or
   * Khalti's own page and only ever reaches the books once the server has
   * verified it with the provider.
   */
  const openSettle = useCallback((documentId: string, direction: 'INCOMING' | 'OUTGOING') => {
    if (!isSupported('payments')) {
      notify(unsupportedMessage('Recording a settlement'), false);
      return;
    }
    setSettleFor({ documentId, direction });
    setTxnModal('payment');
  }, [notify]);

  const openCollect = useCallback((saleId?: string) => {
    // Both halves are required: the RPCs that record a provider interaction and
    // a server that can reach the provider. Without the second, the honest
    // answer is no — not a button that opens a form which cannot complete.
    if (!isSupported('gateway')) {
      notify(unsupportedMessage('Collecting online'), false);
      return;
    }
    if (!onlineCollectionAvailable()) {
      notify(PAYMENT_API_DISABLED_MESSAGE, false);
      return;
    }
    setCollectFor(saleId); setCollectOpen(true);
  }, [notify]);

  /** The signed-in screen the URL names. Anything else renders its own page. */
  const activeTab: ViewTab = route.kind === 'app' ? route.tab : 'dashboard';
  const notFoundPath = route.kind === 'not-found' ? route.path : '';

  const currentDocKind = activeTab === 'sales' ? 'sales' : activeTab === 'purchases' ? 'purchases'
    : activeTab === 'expenses' ? 'expenses' : activeTab === 'payments' ? 'payments' : null;

  const quickActionForTab: Record<string, TxnKind> = {
    sales: 'sale', purchases: 'purchase', expenses: 'expense', payments: 'payment',
  };

  const userRole: AppRole | undefined = user?.appRole;
  const dashboardAccess = isPayingTier(userRole) || user?.isStaff === true;

  /**
   * Which sidebar sections this role has not paid for — the list that drives
   * the drawer locks, the plan-lock screen and whether "New" appears.
   *
   * Derived entirely from `roleHasFeature`, so `ROLE_GATING_ENABLED` in
   * lib/roles is the only place the locks are decided.
   */
  const lockedTabs: ViewTab[] = (Object.keys(TITLES) as ViewTab[]).filter(
    (tab) => !roleHasFeature(userRole, tab) && !(tab === 'dashboard' && !dashboardAccess),
  );

  const headerActions = useMemo(() => {
    if (currentDocKind && !lockedTabs.includes(activeTab)) {
      const kind = quickActionForTab[currentDocKind]!;
      const supported = isSupported(CAPABILITY_FOR_TXN[kind]);
      return (
        <Button
          variant="primary"
          onClick={() => openQuickAction(kind)}
          disabled={!supported}
          title={supported ? undefined : unsupportedMessage(TXN_LABELS[kind])}
        >
          <Plus size={13} aria-hidden="true" /> New
        </Button>
      );
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocKind, openQuickAction, lockedTabs, activeTab]);

  const signOutNow = useCallback(() => { void exitSession('this-device'); }, [exitSession]);
  const retryLoad = useCallback(() => { void loadUserBusinessAndData(); }, [loadUserBusinessAndData]);

  const phase = resolveAppPhase({ session: sessionPhase, membership, data: dataState });

  /**
   * Where this session belongs, given the path it asked for.
   *
   * A signed-in person landing on the marketing page or the sign-in screen is
   * sent to their books (`replace`, so Back does not bounce). A signed-out
   * person asking for a book screen is NOT redirected: they keep the path and
   * see the sign-in screen, so signing in lands them where they were going.
   *
   * Every role reaches the dashboard now. What a plan unlocks is decided per
   * section (`lockedTabs` below), not by bouncing URLs. An admin's `/king`
   * is not affected; the role-aware gating happens when the route is matched.
   */
  const authenticated = Boolean(user) && sessionPhase === 'authenticated';
  const isExplicitLanding = typeof window !== 'undefined' && window.location.search.includes('landing=1');

  let redirect: string | null = null;
  if (!isExplicitLanding && authenticated) {
    redirect = redirectFor(route, authenticated);
    // If they typed /king without admin role, route it away to 404 below —
    // do not redirect silently so the URL stays honest in the address bar.
  }
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirect, navigate]);

  /**
   * When a signed-in user lands on /pricing they can pick a plan. Until the
   * eSewa / Khalti wiring is live, the pick is a no-op (the only path to a
   * real tier change is the admin's /king panel); we still acknowledge the
   * click so the UI feels responsive.
   */
  const handlePickPlan = useCallback((plan: 'user' | 'plus' | 'premium' | 'admin') => {
    if (plan === 'plus' || plan === 'premium') {
      notify(
        `Online checkout for ${plan === 'plus' ? 'Plus' : 'Premium'} is not wired yet — please contact us to upgrade.`,
        true,
      );
    }
  }, [notify]);

  if (authenticated && user && isExplicitLanding && route.kind === 'landing') {
    return <LandingPage onSignIn={() => navigate('/dashboard')} currentPath="/" navigate={navigate} />;
  }

  if (phase === 'checking-session' || redirect) {
    // `redirect` is set only for a session we already know about, so waiting
    // here is what stops the marketing page flashing up in front of someone's
    // books on every refresh of the root URL.
    return <LoadingScreen message="Loading Zeyks Book…" />;
  }

  /**
   * The hidden admin panel at `/king`. Anyone not in role='admin' gets a real
   * 404 — never a silent redirect — so the URL itself never admits the panel
   * exists.
   */
  if (route.kind === 'king') {
    if (!user?.isStaff) {
      return (
        <NotFoundView
          path="/king" authenticated={authenticated}
          onHome={() => navigate('/')} onSignIn={() => navigate('/signin')}
        />
      );
    }
    return (
      <KingPanel
        currentPath={path}
        navigate={navigate}
        onSignOut={() => exitSession('this-device')}
      />
    );
  }

  /**
   * An intent page is rendered for whoever asks for it, signed in or not, and
   * without waiting for a book to load. It shows no data, so a customer reading
   * about hallbooks or VAT is never shown someone's ledger — and bouncing them
   * to the dashboard for clicking a footer link would make the page unreadable
   * to the people who already pay for the product.
   */
  const guide = route.kind === 'guide' ? intentPageForPath(route.path) : null;
  if (guide) {
    return (
      <IntentPageView
        page={guide}
        currentPath={guide.path}
        navigate={navigate}
        onSignIn={() => navigate('/signin')}
      />
    );
  }

  if (authenticated && profileError && route.kind === 'app') {
    return <ErrorScreen title="Unable to load your account" message={profileError}
      onRetry={() => { if (user) setAuthEvent({ action: 'bootstrap', session: { user: { id: user.id, email: user.email } }, key: Date.now() }); }}
      onSignOut={signOutNow} />;
  }

  /**
   * A signed-in user without a subscription (role='user') sees the whole app
   * shell with every section locked: the dashboard tab is open — it is the
   * door that lists the plans — and every other tab shows the plan screen.
   * The onboarding form and the transaction modals are deliberately
   * unreachable from this screen, so nothing can be added, edited or erased
   * until a plan is bought. /pricing, /about and the other public pages stay
   * reachable as marketing.
   *
   * This wall is gated by the same switch as the section locks: with
   * `ROLE_GATING_ENABLED` off every signed-in account walks straight into the
   * app instead of meeting the plan page here.
   */
  if (authenticated && paywallHoldsAccount(userRole) && route.kind === 'app') {
    return (
      <div className="min-h-screen bg-[var(--bg-secondary)]">
        <Sidebar
          currentTab={activeTab}
          onSelect={(t) => { navigate(pathForTab(t)); setMobileSidebarOpen(false); }}
          businessName={business.businessName}
          isOpenMobile={mobileSidebarOpen} onCloseMobile={() => setMobileSidebarOpen(false)}
          issueCount={0}
          lockedTabs={lockedTabs}
          onHome={() => navigate('/?landing=1')}
          accountEmail={user?.email} onSignOut={signOutNow} signingOut={signingOut}
        />
        <div className="lg:pl-60">
          <Header
            title={TITLES[activeTab]}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            mobileSidebarOpen={mobileSidebarOpen}
          />
          <main>
            <PlanLockedView
              role={userRole}
              section={activeTab === 'dashboard' ? undefined : TITLES[activeTab]}
              feature={activeTab === 'dashboard' ? undefined : activeTab}
              onSignOut={signOutNow}
            />
          </main>
        </div>
        {toast && <Toast key={toast.key} message={toast.message} ok={toast.ok} onDismiss={() => setToast(null)} />}
      </div>
    );
  }

  if (route.kind === 'subscribe') {
    return (
      <SubscribeView
        role={userRole}
        email={user?.email ?? null}
        onHome={() => navigate('/?landing=1')}
        onSignOut={() => exitSession('this-device')}
      />
    );
  }

  if (phase === 'unauthenticated' || !user) {
    if (route.kind === 'not-found') {
      return (
        <NotFoundView
          path={route.path} authenticated={false}
          onHome={() => navigate('/')} onSignIn={() => navigate('/signin')}
        />
      );
    }
    if (route.kind === 'landing') {
      return <LandingPage onSignIn={() => navigate('/signin')} currentPath="/" navigate={navigate} />;
    }
    if (route.kind === 'demo') {
      return (
        <Suspense fallback={<LoadingScreen message="Loading interactive demo…" />}>
          <DemoPage currentPath="/demo" navigate={navigate} onSignIn={() => navigate('/signin')} />
        </Suspense>
      );
    }
    if (route.kind === 'pricing') {
      return (
        <PricingPage
          currentPath="/pricing" navigate={navigate} onSignIn={() => navigate('/signin')}
          signedIn={authenticated}
          onPickPlan={handlePickPlan}
        />
      );
    }
    if (route.kind === 'about') {
      return (
        <>
          <AboutPage currentPath="/about" navigate={navigate} onSignIn={() => navigate('/signin')} />
        </>
      );
    }
    if (route.kind === 'contact') {
      return (
        <>
          <ContactPage currentPath="/contact" navigate={navigate} onSignIn={() => navigate('/signin')} />
        </>
      );
    }
    if (route.kind === 'privacy') {
      return (
        <>
          <PrivacyPage currentPath="/privacy" navigate={navigate} onSignIn={() => navigate('/signin')} />
        </>
      );
    }
    if (route.kind === 'terms') {
      return (
        <>
          <TermsPage currentPath="/terms" navigate={navigate} onSignIn={() => navigate('/signin')} />
        </>
      );
    }
    // The sign-in screen, at `/signin` and at any book screen that needs a
    // session. The requested path is kept, so signing in continues to it.
    return (
      <AuthModal
        isOpen onSignedIn={handleSignedIn}
        arrivalNotice={sessionNotice} arrivalNoticeTone="warn"
      />
    );
  }

  if (phase === 'membership-error') {
    return (
      <ErrorScreen
        title="Unable to load your account"
        message={membership.kind === 'error' ? membership.message : 'Could not check your business membership.'}
        busy={resolving}
        onRetry={retryLoad}
        onSignOut={signOutNow}
      />
    );
  }

  if (phase === 'data-error') {
    return (
      <ErrorScreen
        title="Unable to load books"
        message={dataState.kind === 'error' ? dataState.message : 'Could not load your book data.'}
        busy={resolving}
        onRetry={retryLoad}
        onSignOut={signOutNow}
      />
    );
  }

  if (phase === 'loading-memberships' || phase === 'loading-data') {
    return <LoadingScreen message="Loading your books…" />;
  }

  if (phase === 'onboarding') {
    return (
      <OnboardingGate
        onComplete={handleOnboardingComplete}
        busy={onboardingBusy}
        error={onboardingError}
      />
    );
  }

  // phase === 'ready'
  return (
    <div className="min-h-screen bg-[var(--bg-secondary)]">
      <Sidebar
        currentTab={activeTab}
        onSelect={(t) => { navigate(pathForTab(t)); setMobileSidebarOpen(false); }}
        businessName={business.businessName}
        isOpenMobile={mobileSidebarOpen} onCloseMobile={() => setMobileSidebarOpen(false)}
        issueCount={integrityIssues.filter((i) => i.severity === 'ERROR').length}
        lockedTabs={lockedTabs}
        onHome={() => navigate('/?landing=1')}
        accountEmail={user?.email} onSignOut={signOutNow} signingOut={signingOut}
      />

      <div className="lg:pl-60">
        <Header
          title={notFoundPath ? 'Not found' : TITLES[activeTab]}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          mobileSidebarOpen={mobileSidebarOpen}
          actions={headerActions}
        />

        {offline && (
          <div role="status" aria-live="polite" className="bg-[var(--bg-tertiary)] border-b border-[var(--separator)] text-[var(--label-secondary)] text-[13px] leading-[18px] px-4 py-2">
            You are offline — showing the books as of {offlineSavedAt ? new Date(offlineSavedAt).toLocaleString() : 'your last sync'}.
            This copy is read-only; changes are disabled until you reconnect.
          </div>
        )}

        {storageError && (
          <div role="alert" className="bg-[var(--destructive-bg)] border-b border-[var(--destructive)]/30 text-[var(--destructive)] text-[13px] leading-[18px] px-4 py-2">
            {storageError}
          </div>
        )}

        <main>
          <Suspense fallback={<LoadingScreen message="Loading your books…" />}>
            {/* Unknown URLs stay inside the app shell so its navigation remains available. */}
            {notFoundPath ? (
              <NotFoundView
                embedded path={notFoundPath} authenticated
                onHome={() => navigate(pathForTab('dashboard'))}
                onSignIn={() => navigate('/signin')}
              />
            ) : lockedTabs.includes(activeTab) ? (
              <PlanLockedView role={userRole} section={TITLES[activeTab]} feature={activeTab} />
            ) : (
              <>
                {activeTab === 'dashboard' && (
                  <DashboardView
                    books={books} range={range} onRangeChange={updateRange} calendar={calendar}
                    role={userRole}
                    onPickPlan={handlePickPlan}
                    onQuickAction={openQuickAction}
                    onGoToHealth={() => navigate(pathForTab('health'))}
                    onGoToInventory={() => navigate(pathForTab('inventory'))}
                  />
                )}
                {currentDocKind && (
                  <DocumentsView
                    kind={currentDocKind} books={books} calendar={calendar}
                    onNew={() => openQuickAction(quickActionForTab[currentDocKind]!)}
                    onCollect={(saleId) => openCollect(saleId)}
                    onReceive={(saleId) => openSettle(saleId, 'INCOMING')}
                    onSettle={(purchaseId) => openSettle(purchaseId, 'OUTGOING')}
                    onDone={notify}
                  />
                )}
                {activeTab === 'reports' && (
                  <ReportsView books={books} range={range} onRangeChange={updateRange} calendar={calendar} />
                )}
                {activeTab === 'health' && <HealthView books={books} onDone={notify} />}
                {activeTab === 'settings' && (
                  <SettingsView
                    books={books} onDone={notify}
                    calendar={calendar} onCalendarChange={changeCalendar}
                    onSignOut={exitSession} signingOut={signingOut}
                  />
                )}
                {activeTab === 'inventory' && (
                  <InventoryView
                    businessId={business.id}
                    trackInventory={business.trackInventory}
                    onTrackChanged={(next) => { setBusiness({ ...business, trackInventory: next }); }}
                    calendar={calendar}
                    notify={notify}
                  />
                )}
              </>
            )}
          </Suspense>
        </main>
      </div>

      <TransactionModal
        isOpen={txnModal !== null} kind={txnModal ?? 'sale'}
        onClose={() => { setTxnModal(null); setSettleFor(undefined); }}
        books={books} calendar={calendar} onDone={notify}
        preselectDocumentId={settleFor?.documentId}
        preselectDirection={settleFor?.direction}
      />
      <CollectOnlineModal
        isOpen={collectOpen} onClose={() => setCollectOpen(false)} books={books}
        config={gatewayConfig} preselectSaleId={collectFor} onDone={notify}
      />

      {toast && <Toast key={toast.key} message={toast.message} ok={toast.ok} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export const _todayForTest = todayNpt;
export const _capabilitiesForTest = CAPABILITIES;
