/**
 * Focus behaviour shared by every overlay that claims to be a dialog.
 *
 * `role="dialog"` + `aria-modal="true"` is a promise to a screen-reader user:
 * the keyboard is inside this surface, it stays inside until the surface closes,
 * and closing it returns the keyboard where it was. An overlay that renders the
 * attributes without the behaviour is worse than one with neither — the promise
 * is the reason assistive technology stops announcing the page behind it.
 *
 * This hook keeps the promise in one place so the modal and the printable
 * document cannot drift apart:
 *
 *   - on open, focus moves to the first focusable control inside the panel (or
 *     to the panel itself, which is why the panel needs `tabIndex={-1}`);
 *   - Tab and Shift+Tab cycle within the panel;
 *   - Escape closes, when the caller allows dismissal;
 *   - on close, focus returns to whatever held it before.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Everything a keyboard can reach, in document order. */
export const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogFocusOptions {
  isOpen: boolean;
  /** The element that contains the dialog — the thing focus is trapped in. */
  panel: RefObject<HTMLElement | null>;
  /** Called on Escape. Omit (or pass null) for a screen that cannot be left. */
  onEscape?: (() => void) | null;
  /** Keep the page behind the overlay from scrolling. Defaults to true. */
  lockScroll?: boolean;
}

export function useDialogFocus({
  isOpen,
  panel,
  onEscape = null,
  lockScroll = true,
}: DialogFocusOptions): void {
  const restoreTo = useRef<HTMLElement | null>(null);
  // The latest callback, without restarting the trap on every parent render:
  // several callers pass an inline arrow function, and restarting would steal
  // focus from a text input mid-keystroke.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!isOpen) return undefined;

    restoreTo.current = (document.activeElement as HTMLElement | null) ?? null;

    // Preserve an autofocus the caller placed deliberately: only move focus
    // when nothing inside the dialog already has it.
    const active = document.activeElement as HTMLElement | null;
    const alreadyInside = Boolean(active && panel.current?.contains(active) && active.matches(FOCUSABLE));
    if (!alreadyInside) {
      const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel.current)?.focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Never let an inner dialog's Escape also close the one behind it.
        event.stopPropagation();
        escapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      // `offsetParent === null` skips anything the layout has hidden, so a
      // closed drawer inside the dialog cannot swallow the Tab cycle.
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((element) => element.offsetParent !== null);
      if (items.length === 0) return;

      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [isOpen, lockScroll, panel]);
}
