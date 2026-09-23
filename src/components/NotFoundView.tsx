import React from 'react';
import { BookOpen, Compass } from 'lucide-react';
import { Button } from './ui';

/**
 * A real 404.
 *
 * Before routing was URL-driven there was no such thing as an unknown path: any
 * address rendered whatever the application's initial state happened to be, so
 * a mistyped link looked like a working (empty) screen. This page exists so a
 * path the app does not serve says so, offers a way back, and renders no
 * financial data at all.
 */
export const NotFoundView: React.FC<{
  /** The path that was asked for, shown back so a typo is obvious. */
  path: string;
  /** Where the person can go: their books when signed in, the landing page otherwise. */
  authenticated: boolean;
  /** Inside the signed-in shell, where the sidebar already frames the page. */
  embedded?: boolean;
  onHome: () => void;
  onSignIn: () => void;
}> = ({ path, authenticated, embedded = false, onHome, onSignIn }) => (
  <div className={embedded
    ? 'flex items-start justify-center px-4 py-10 sm:py-16'
    : 'flex min-h-screen items-center justify-center bg-[var(--bg-secondary)] p-4'}>
    <div className="w-full max-w-md rounded-[14px] border border-[var(--separator)] bg-[var(--bg)] p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)]">
          <BookOpen size={15} strokeWidth={1.8} className="text-white" aria-hidden="true" />
        </span>
        <span className="text-[15px] font-semibold text-[var(--label)]">Zeyks Book</span>
        <span className="ml-auto text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--label-tertiary)]">
          404
        </span>
      </div>

      <h1 className="mt-6 text-[22px] leading-[28px] font-semibold tracking-tight text-[var(--label)]">
        We could not find that page
      </h1>
      <p className="mt-2 text-[15px] leading-[20px] text-[var(--label-secondary)]">
        Nothing in Zeyks Book is served at this address. Check the link, or go back to somewhere
        that exists.
      </p>
      <p className="mt-3 truncate rounded-md border border-[var(--separator)] bg-[var(--bg-secondary)] px-2.5 py-2 font-mono text-[12px] text-[var(--label-secondary)]">
        {path}
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        {authenticated ? (
          <Button variant="primary" size="md" onClick={onHome}>
            <Compass size={13} strokeWidth={1.8} aria-hidden="true" /> Go to the dashboard
          </Button>
        ) : (
          <>
            <Button variant="primary" size="md" onClick={onSignIn}>
              Sign in
            </Button>
            <Button size="md" onClick={onHome}>Go to the home page</Button>
          </>
        )}
      </div>
    </div>
  </div>
);
