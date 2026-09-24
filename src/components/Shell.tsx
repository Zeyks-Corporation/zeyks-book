import React, { useEffect, useRef, useState } from 'react';
import {
  CreditCard, FileText, Gauge, Heart, Menu, Receipt, Settings,
  ShoppingBag, Wallet, X,
} from 'lucide-react';
import { ViewTab } from '../types';

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
  { tab: 'expenses', label: 'Expenses', icon: Wallet },
  { tab: 'payments', label: 'Payments', icon: CreditCard },
  { tab: 'reports', label: 'Reports', icon: FileText },
  { tab: 'health', label: 'Data health', icon: Heart },
  { tab: 'settings', label: 'Settings', icon: Settings },
];

/** The desktop breakpoint. Below it the sidebar is a drawer; above it, a fixture. */
const DESKTOP_QUERY = '(min-width: 1024px)';

/** The control that opens the drawer — where focus goes when it closes again. */
const MENU_BUTTON_ID = 'app-menu-button';

/**
 * Is the viewport wide enough that the sidebar is always on screen?
 *
 * The closed drawer is hidden by a CSS transform, which removes nothing from the
 * tab order or the accessibility tree: the navigation stayed focusable, so a
 * keyboard user tabbing through a phone layout walked into off-screen controls,
 * and a screen reader announced a menu that was not on screen. `inert` and
 * `aria-hidden` are the fix, but only while the sidebar really is off-screen —
 * on a desktop viewport it is visible and must stay usable, which is a media
 * query rather than React state.
 */
function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}

export const Sidebar: React.FC<{
  currentTab: ViewTab; onSelect: (t: ViewTab) => void; businessName: string;
  isOpenMobile: boolean; onCloseMobile: () => void; issueCount: number;
  hideTabs?: ViewTab[];
}> = ({ currentTab, onSelect, businessName, isOpenMobile, onCloseMobile, issueCount, hideTabs = [] }) => {
  const isDesktop = useIsDesktopViewport();
  /** Off a desktop viewport the sidebar is a drawer; closed, it is unreachable. */
  const unreachable = !isDesktop && !isOpenMobile;

  // Closing the drawer hands the keyboard back to the control that opened it,
  // instead of dropping focus at the top of the document.
  const wasOpen = useRef(isOpenMobile);
  useEffect(() => {
    if (wasOpen.current && !isOpenMobile) {
      window.document.getElementById(MENU_BUTTON_ID)?.focus();
    }
    wasOpen.current = isOpenMobile;
  }, [isOpenMobile]);

  return (
    <>
      {isOpenMobile && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onCloseMobile} aria-hidden="true" />
      )}
      <aside
        id="app-sidebar"
        aria-hidden={unreachable ? true : undefined}
        inert={unreachable}
        className={`fixed inset-y-0 left-0 z-40 w-60 bg-[var(--bg)] border-r border-[var(--separator)] flex flex-col transition-transform lg:translate-x-0 ${
          isOpenMobile ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
      <div className="h-14 px-4 flex items-center justify-between border-b border-[var(--separator)]">
        <div className="flex items-center gap-2 min-w-0">
          <img src="/favicon.svg" alt="Zeyks Book Logo" className="h-5 w-5 shrink-0 object-contain" />
          <span className="text-[15px] font-semibold text-[var(--label)] truncate">
            {businessName || 'Zeyks Book'}
          </span>
        </div>
        <button type="button" onClick={onCloseMobile} aria-label="Close menu"
          className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--label-tertiary)] hover:text-[var(--label)] p-1 -mr-1 rounded">
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          {NAV.filter((item) => !hideTabs.includes(item.tab)).map(({ tab, label, icon: Icon }) => {
            const active = currentTab === tab;
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
                  {tab === 'health' && issueCount > 0 && (
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
  actions?: React.ReactNode;
}> = ({ title, onOpenMobileSidebar, actions }) => (
  <header className="app-header h-14 glass-regular border-b border-[var(--separator)] sticky top-0 z-20 flex items-center gap-3 px-4">
    <button
      type="button"
      id={MENU_BUTTON_ID}
      onClick={onOpenMobileSidebar}
      aria-label="Open menu"
      className="lg:hidden min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--label-secondary)] hover:text-[var(--label)] p-1 -ml-1 rounded"
    >
      <Menu size={18} strokeWidth={1.8} aria-hidden="true" />
    </button>
    <h1 className="text-[17px] leading-[22px] font-semibold text-[var(--label)] grow truncate">{title}</h1>
    {actions && <div className="flex items-center gap-2">{actions}</div>}
  </header>
);
