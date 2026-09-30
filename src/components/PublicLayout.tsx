import React, { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Button } from './ui';

const NAV_LINKS = [
  { path: '/demo', label: 'Demo' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/about', label: 'About' },
  { path: '/contact', label: 'Contact' },
] as const;

export const PublicLayout: React.FC<{
  currentPath: string;
  navigate: (to: string) => void;
  onSignIn: () => void;
  children: React.ReactNode;
}> = ({ currentPath, navigate, onSignIn, children }) => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] text-[var(--label)] transition-colors duration-300">
      {/* ── Liquid Glass Navigation Bar ── */}
      <header className="sticky top-0 z-30 border-b border-[var(--separator)] bg-[var(--bg)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          {/* Logo */}
          <button
            type="button"
            onClick={() => {
              setMobileMenuOpen(false);
              navigate('/');
            }}
            className="flex items-center gap-2.5 min-h-[44px] px-1 rounded-[10px] hover:bg-[var(--fill-secondary)] transition-all group"
            aria-label="Zeyks Book home"
          >
            <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-10 w-9 shrink-0 object-contain transition-transform group-hover:scale-105" />
          </button>

          {/* Desktop Nav links + Sign In (sm and up) */}
          <nav aria-label="Public pages" className="hidden sm:flex items-center gap-1 sm:gap-2">
            {NAV_LINKS.map(({ path, label }) => {
              const active = currentPath === path;
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => navigate(path)}
                  aria-current={active ? 'page' : undefined}
                  className={`min-h-[44px] px-3 py-2 rounded-[10px] text-[14px] sm:text-[15px] leading-[20px] font-medium transition-all ${
                    active
                      ? 'bg-[var(--fill-secondary)] text-[var(--label)] font-semibold shadow-xs'
                      : 'text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--label)]'
                  }`}
                >
                  {label}
                </button>
              );
            })}

            <Button
              variant="primary"
              size="sm"
              className="ml-2 rounded-full px-4 h-9 shadow-xs"
              onClick={onSignIn}
            >
              Sign in
            </Button>
          </nav>

          {/* Mobile hamburger menu bar button (< 640px) */}
          <button
            type="button"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            className="sm:hidden flex h-10 w-10 min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-[var(--label)] hover:bg-[var(--fill-secondary)] transition-colors"
            aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>

        {/* Mobile dropdown menu */}
        {mobileMenuOpen && (
          <div className="sm:hidden border-t border-[var(--separator)] bg-[var(--bg)] px-4 py-3 space-y-1.5 shadow-lg">
            {NAV_LINKS.map(({ path, label }) => {
              const active = currentPath === path;
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    navigate(path);
                  }}
                  aria-current={active ? 'page' : undefined}
                  className={`w-full text-left min-h-[44px] px-3.5 py-2.5 rounded-lg text-[15px] font-medium transition-all ${
                    active
                      ? 'bg-[var(--fill-secondary)] text-[var(--label)] font-semibold'
                      : 'text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--label)]'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <div className="pt-2 border-t border-[var(--separator)]">
              <Button
                variant="primary"
                size="md"
                className="w-full rounded-full py-2.5 text-[15px] font-semibold"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onSignIn();
                }}
              >
                Sign in
              </Button>
            </div>
          </div>
        )}
      </header>

      {/* ── Page Content ── */}
      <main>{children}</main>

      {/* ── Apple Structured Footer ── */}
      <footer className="border-t border-[var(--separator)] bg-[var(--bg)] transition-colors duration-300">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
          <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
            {/* Brand */}
            <div className="max-w-xs">
              <div className="flex items-center gap-2">
                <img src="/zeyks-mark.png" alt="Zeyks Book" className="h-12 w-10 shrink-0 object-contain" />
              </div>
              <p className="mt-3 text-[13px] leading-[20px] text-[var(--label-secondary)]">
                Double-entry bookkeeping for Nepali businesses, with Bikram Sambat dates, NPR amounts, and printable A4 reports.
              </p>
            </div>

            {/* Links */}
            <div className="flex flex-wrap gap-12">
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--label-tertiary)]">
                  Platform
                </h3>
                <ul className="mt-3.5 space-y-2">
                  {[
                    { path: '/', label: 'Overview' },
                    { path: '/pricing', label: 'Pricing' },
                  ].map(({ path, label }) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => navigate(path)}
                        className="text-[13px] text-[var(--label-secondary)] hover:text-[var(--label)] transition-colors"
                      >
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--label-tertiary)]">
                  Company
                </h3>
                <ul className="mt-3.5 space-y-2">
                  {[
                    { path: '/about', label: 'About Us' },
                    { path: '/contact', label: 'Contact' },
                  ].map(({ path, label }) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => navigate(path)}
                        className="text-[13px] text-[var(--label-secondary)] hover:text-[var(--label)] transition-colors"
                      >
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--label-tertiary)]">
                  Legal
                </h3>
                <ul className="mt-3.5 space-y-2">
                  {[
                    { path: '/privacy', label: 'Privacy Policy' },
                    { path: '/terms', label: 'Terms of Service' },
                  ].map(({ path, label }) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => navigate(path)}
                        className="text-[13px] text-[var(--label-secondary)] hover:text-[var(--label)] transition-colors"
                      >
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Bottom copyright bar */}
          <div className="mt-10 border-t border-[var(--separator)] pt-6 flex flex-col gap-2 sm:flex-row sm:items-center text-[12px] text-[var(--label-tertiary)]">
            <p>© {new Date().getFullYear()} · Janakpur and Biratnagar, Nepal</p>
            <p className="sm:ml-auto">
              A4-formatted reports and VAT statements are working documents — review them
              with your accountant. IRD approval is not claimed.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};
