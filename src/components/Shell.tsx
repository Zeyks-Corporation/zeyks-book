import React, { useEffect, useRef, useState } from 'react';
import {
  CreditCard, FileText, Gauge, Heart, Lock, Menu, Package, Receipt, Settings,
  ShoppingBag, Wallet, Wrench, X,
} from 'lucide-react';
import { ViewTab } from '../types';

/** Tailwind's `lg` breakpoint: at and above this the sidebar is permanent. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/**
 * Whether the sidebar is currently permanent (desktop) or a drawer (mobile).
 *
 * The CSS decides where the drawer sits; this decides whether it exists for the
 * keyboard and for assistive technology, because a drawer translated off-screen
 * is still in the tab order until something takes it out.
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    query.addEventListener('change', onChange);
    setIsDesktop(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

/**
 * The sidebar's own navigation, in the order a book is read.
 *
 * Every entry is a real address (see lib/routes.ts), so `onSelect` navigates
 * rather than setting state: the current screen has one source of truth and it
 * is the URL.
 */

const NAV: { tab: ViewTab; label: string; icon: React.ElementType }[] = [
  { tab: 'dashboard', label: 'Dashboard', icon: Gauge },
  { tab: 'sales', label: 'Sales', icon: Receipt },
  { tab: 'purchases', label: 'Purchases', icon: ShoppingBag },
  { tab: 'inventory', label: 'Inventory', icon: Package },
  { tab: 'tools', label: 'Premium tools', icon: Wrench },
  { tab: 'expenses', label: 'Expenses', icon: Wallet },
  { tab: 'payments', label: 'Payments', icon: CreditCard },
  { tab: 'reports', label: 'Reports', icon: FileText },
  { tab: 'health', label: 'Data health', icon: Heart },
  { tab: 'settings', label: 'Settings', icon: Settings },
];

export const Sidebar: React.FC<{
  currentTab: ViewTab; onSelect: (t: ViewTab) => void; businessName: string;
  isOpenMobile: boolean; onCloseMobile: () => void; issueCount: number;
  /** Tabs the current plan does not unlock. They stay visible, marked with a lock. */
  lockedTabs?: ViewTab[];
  /** Jump out to the public landing page. */
  onHome?: () => void;
  /**
   * The signed-in account, shown at the foot of the list of books.
   *
   * A laptop in a shop is used by more than one person, and a session outlives
   * the tab that opened it, so the first question on any screen is "whose books
   * are these". The address answers it without anyone having to open Settings.
   */
  accountEmail?: string | null;
  /** End this browser's session. Given only when there is a session to end. */
  onSignOut?: () => void;
  signingOut?: boolean;
}> = ({ currentTab, onSelect, businessName, isOpenMobile, onCloseMobile, issueCount, lockedTabs = [], onHome, accountEmail, onSignOut, signingOut = false }) => {
  const isDesktop = useIsDesktop();
  // Closed on a phone means gone: `inert` takes the whole drawer out of the tab
  // order and away from assistive technology, which `-translate-x-full` cannot.
  const hidden = !isDesktop && !isOpenMobile;

  const wasOpen = useRef(isOpenMobile);
  useEffect(() => {
    if (wasOpen.current && !isOpenMobile) {
      document.getElementById('app-menu-trigger')?.focus();
    }
    wasOpen.current = isOpenMobile;
  }, [isOpenMobile]);

  const handleHome = () => {
    onCloseMobile();
    onHome?.();
  };

  return (
  <>
    {isOpenMobile && (
      <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onCloseMobile} aria-hidden="true" />
    )}
    <aside
      id="app-sidebar"
      inert={hidden || undefined}
      aria-hidden={hidden || undefined}
      className={`fixed inset-y-0 left-0 z-40 w-60 bg-[var(--bg)] border-r border-[var(--separator)] flex flex-col transition-transform lg:translate-x-0 ${
        isOpenMobile ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="h-14 px-4 flex items-center justify-between border-b border-[var(--separator)] gap-2">
        <button
          type="button"
          onClick={handleHome}
          className="flex items-center gap-2 min-w-0 min-h-[44px] px-1 -ml-1 rounded-[10px] hover:bg-[var(--fill-secondary)] active:bg-[var(--fill-secondary)] transition-colors text-left"
          aria-label="Go to landing page"
          title="Go to landing page"
        >
          <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-9 w-8 shrink-0 object-contain" />
          {businessName ? (
            <span className="text-[15px] font-semibold text-[var(--label)] truncate">
              {businessName}
            </span>
          ) : (
            <span className="text-[15px] font-semibold text-[var(--label)] truncate">
              Zeyks Book
            </span>
          )}
        </button>
        <button type="button" onClick={onCloseMobile} aria-label="Close menu"
          className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--label-tertiary)] hover:text-[var(--label)] p-1 -mr-1 rounded">
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {NAV.map(({ tab, label, icon: Icon }) => {
            const active = currentTab === tab;
            const locked = lockedTabs.includes(tab);
            return (
              <li key={tab}>
                <button
                  type="button" onClick={() => onSelect(tab)} aria-current={active ? 'page' : undefined}
                  className={`w-full flex items-center gap-2.5 rounded-[10px] min-h-[44px] px-2.5 py-2 text-[15px] leading-[20px] font-medium transition-colors ${
                    active ? 'bg-[var(--fill-secondary)] text-[var(--label)]' : 'text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)]'
                  }`}
                >
                  <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                  <span>{label}</span>
                  {locked && (
                    <Lock size={12} strokeWidth={2} aria-hidden="true" className="ml-auto shrink-0 text-[var(--label-tertiary)]" />
                  )}
                  {!locked && tab === 'health' && issueCount > 0 && (
                    <span className="ml-auto rounded bg-[var(--destructive-bg)] px-1.5 py-0.5 text-[12px] font-semibold text-[var(--destructive)] tabular-nums">
                      {issueCount}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {accountEmail && (
        <div className="border-t border-[var(--separator)] p-3 flex items-center gap-2">
          <div className="min-w-0 grow">
            <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--label-tertiary)]">Signed in</p>
            <p className="text-[13px] text-[var(--label)] truncate" title={accountEmail}>{accountEmail}</p>
          </div>
          {onSignOut && (
            <button
              type="button" onClick={onSignOut} disabled={signingOut}
              className="shrink-0 rounded-[10px] min-h-[36px] px-2.5 text-[13px] font-medium text-[var(--label-secondary)] border border-[var(--separator)] hover:bg-[var(--fill-secondary)] disabled:opacity-50"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          )}
        </div>
      )}
    </aside>
  </>
  );
};

/**
 * The top bar.
 *
 * The date-calendar and currency-symbol toggles used to live here, on every
 * screen of the application. They are settings, not daily actions, so they now
 * live in Settings · Currency & date with every other display choice, and the
 * bar carries only the screen's title and its own action.
 */
export const Header: React.FC<{
  title: string;
  onOpenMobileSidebar: () => void;
  /** Whether the mobile drawer is open, so the trigger can say so. */
  mobileSidebarOpen?: boolean;
  actions?: React.ReactNode;
}> = ({ title, onOpenMobileSidebar, mobileSidebarOpen = false, actions }) => (
  <header className="app-header h-14 glass-regular border-b border-[var(--separator)] sticky top-0 z-20 flex items-center gap-2 px-3 sm:px-4">
    <button type="button" id="app-menu-trigger" onClick={onOpenMobileSidebar} aria-label="Open menu"
      aria-expanded={mobileSidebarOpen}
      aria-controls="app-sidebar"
      className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--label-secondary)] hover:text-[var(--label)] p-1 -ml-1 rounded">
      <Menu size={18} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <h1 className="text-[17px] leading-[22px] font-semibold text-[var(--label)] grow truncate">{title}</h1>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </header>
);
