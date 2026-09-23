import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { formatNpr } from '../lib/money';
import { adToBs, bsToAd, bsDaysInMonth, BS_MONTHS, formatAd, todayNpt, BS_MIN_YEAR, BS_MAX_YEAR } from '../lib/nepaliDate';

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

export const Money: React.FC<{
  value: number; symbol?: string; size?: 'sm' | 'md' | 'lg' | 'xl'; muted?: boolean; className?: string;
}> = ({ value, symbol = 'NPR', size = 'md', muted = false, className = '' }) => {
  const sizes = {
    sm: 'text-[13px]', md: 'text-[15px] font-medium',
    lg: 'text-[20px] font-semibold tracking-tight', xl: 'text-[28px] lg:text-[34px] font-semibold tracking-tight',
  };
  const tone = muted ? 'text-[var(--label-secondary)]' : value < 0 ? 'text-[var(--destructive)]' : 'text-[var(--label)]';
  return <span className={`tabular-nums ${sizes[size]} ${tone} ${className}`}>{formatNpr(value, symbol)}</span>;
};

/* -------------------------------------------------------------------------- */
/* Modal — focus trap, Escape, focus restore, aria wiring                      */
/* -------------------------------------------------------------------------- */

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const Modal: React.FC<{
  isOpen: boolean; onClose: () => void; title: string; description?: string;
  children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg';
  /**
   * A screen the person cannot step out of — the sign-in screen, which has
   * nothing behind it — declares itself and gets no close button, no Escape and
   * no backdrop dismissal, rather than a control that visibly does nothing.
   */
  dismissible?: boolean;
}> = ({ isOpen, onClose, title, description, children, footer, size = 'md', dismissible = true }) => {
  const panel = useRef<HTMLDivElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const descId = useId();

  // Keep the latest callback without making the focus-trap effect restart on
  // every parent render. Restarting it on every keystroke steals focus from
  // text inputs because many callers pass an inline onClose callback.
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return undefined;
    restoreTo.current = document.activeElement as HTMLElement;

    // Preserve autofocus (for example, the first field in the setup dialog).
    // Only move focus when nothing inside the dialog is already focused.
    const active = document.activeElement as HTMLElement | null;
    const alreadyFocusedInside = Boolean(active && panel.current?.contains(active) && active.matches(FOCUSABLE));
    if (!alreadyFocusedInside) {
      const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel.current)?.focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); if (dismissible) onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first_ = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first_) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first_.focus(); }
    };

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus();
    };
  }, [isOpen, dismissible]);

  if (!isOpen) return null;
  const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] flex items-center justify-center p-4"
      onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`bg-[var(--bg)] rounded-[14px] border border-[var(--separator)] shadow-xl w-full ${widths[size]} max-h-[92vh] flex flex-col outline-none`}
      >
        <div className="px-5 py-4 border-b border-[var(--separator)] flex items-start justify-between gap-4 shrink-0">
          <div>
            <h2 id={titleId} className="text-[17px] leading-[22px] font-semibold text-[var(--label)]">{title}</h2>
            {description && <p id={descId} className="text-[13px] leading-[18px] text-[var(--label-secondary)] mt-0.5">{description}</p>}
          </div>
          {dismissible && (
            <button
              type="button" onClick={onClose} aria-label="Close dialog"
              className="text-[var(--label-secondary)] hover:text-[var(--label)] rounded p-1 -m-1 shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center"
            >
              <X size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="px-5 py-4 overflow-y-auto grow">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-[var(--separator)] shrink-0 bg-[var(--bg-secondary)]/60 rounded-b-[14px]">{footer}</div>}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Form primitives                                                             */
/* -------------------------------------------------------------------------- */

export const Field: React.FC<{
  label: string; children: (id: string) => React.ReactNode; hint?: string; error?: string; required?: boolean;
}> = ({ label, children, hint, error, required }) => {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[13px] leading-[18px] font-medium text-[var(--label-secondary)]">
        {label}{required && <span className="text-[var(--destructive)] ml-0.5" aria-hidden="true">*</span>}
      </label>
      {children(id)}
      {error
        ? <p role="alert" className="text-[13px] text-[var(--destructive)]">{error}</p>
        : hint ? <p className="text-[13px] text-[var(--label-tertiary)]">{hint}</p> : null}
    </div>
  );
};

export const inputClass =
  'w-full rounded-[10px] border border-[var(--separator)] bg-[var(--bg)] px-3 py-2.5 text-[17px] leading-[22px] text-[var(--label)] min-h-[44px] ' +
  'placeholder:text-[var(--label-tertiary)] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/30 ' +
  'disabled:bg-[var(--bg-secondary)] disabled:text-[var(--label-tertiary)]';

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    /**
     * Padding and type scale, so one button can carry a whole screen without
     * every caller fighting the base classes. `sm` is the density the app is
     * built at; a sign-in screen has one action and can afford `lg`.
     */
    size?: 'sm' | 'md' | 'lg';
  }
> = ({ variant = 'secondary', size = 'sm', className = '', ...props }) => {
  const variants = {
    primary: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] disabled:opacity-40 disabled:bg-[var(--accent)]',
    secondary: 'border border-[var(--separator)] bg-[var(--bg)] text-[var(--label)] hover:bg-[var(--fill-secondary)] disabled:text-[var(--label-tertiary)]',
    ghost: 'text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)] disabled:text-[var(--label-tertiary)]',
    danger: 'border border-[var(--destructive)]/30 bg-[var(--bg)] text-[var(--destructive)] hover:bg-[var(--destructive-bg)] disabled:opacity-40',
  };
  const sizes = {
    sm: 'px-4 py-2.5 text-[15px] min-h-[44px]',
    md: 'px-5 py-3 text-[17px] min-h-[44px]',
    lg: 'px-6 py-3 text-[17px] min-h-[44px]',
  };
  const rounded = variant === 'primary' ? 'rounded-full' : 'rounded-[12px]';
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 font-medium transition-[transform,background-color] active:scale-[0.97] disabled:cursor-not-allowed ${rounded} ${sizes[size]} ${variants[variant]} ${className}`}
    />
  );
};

export const Badge: React.FC<{ tone?: 'neutral' | 'green' | 'amber' | 'rose' | 'blue'; children: React.ReactNode }> =
  ({ tone = 'neutral', children }) => {
    const tones = {
      neutral: 'bg-[var(--fill-secondary)] text-[var(--label-secondary)]',
      green: 'bg-[var(--success-bg)] text-[var(--success)]',
      amber: 'bg-[var(--warning-bg)] text-[var(--warning)]',
      rose: 'bg-[var(--destructive-bg)] text-[var(--destructive)]',
      blue: 'bg-[var(--accent)]/10 text-[var(--accent)]',
    };
    return <span className={`inline-block rounded px-1.5 py-0.5 text-[12px] font-medium ${tones[tone]}`}>{children}</span>;
  };

export const EmptyState: React.FC<{ title: string; action?: React.ReactNode }> = ({ title, action }) => (
  <div className="border border-dashed border-[var(--separator)] rounded-[12px] py-12 px-6 text-center">
    <p className="text-[15px] leading-[20px] text-[var(--label-secondary)]">{title}</p>
    {action && <div className="mt-3 flex justify-center">{action}</div>}
  </div>
);

export const Callout: React.FC<{ tone?: 'warn' | 'error' | 'info'; children: React.ReactNode }> =
  ({ tone = 'info', children }) => {
    const tones = {
      warn: 'border-[var(--warning)]/30 bg-[var(--warning-bg)] text-[var(--warning)]',
      error: 'border-[var(--destructive)]/30 bg-[var(--destructive-bg)] text-[var(--destructive)]',
      info: 'border-[var(--separator)] bg-[var(--fill-secondary)] text-[var(--label-secondary)]',
    };
    return (
      <div role={tone === 'error' ? 'alert' : undefined} className={`flex gap-2 rounded-md border px-3 py-2 text-[13px] leading-[18px] ${tones[tone]}`}>
        <AlertTriangle size={14} strokeWidth={1.8} className="shrink-0 mt-0.5" aria-hidden="true" />
        <div className="grow">{children}</div>
      </div>
    );
  };

/* -------------------------------------------------------------------------- */
/* Dual BS / AD date field                                                     */
/* -------------------------------------------------------------------------- */

export const DateField: React.FC<{
  label: string; value: string; onChange: (iso: string) => void;
  calendar: 'BS' | 'AD'; max?: string; required?: boolean;
}> = ({ label, value, onChange, calendar, max, required }) => {
  const bs = useMemo(() => { try { return adToBs(value); } catch { return null; } }, [value]);
  const yearId = useId();

  if (calendar === 'AD' || !bs) {
    return (
      <Field label={label} required={required} hint={bs ? `BS ${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}` : undefined}>
        {(id) => (
          <input id={id} type="date" value={value} max={max} required={required}
            onChange={(e) => onChange(e.target.value)} className={inputClass} />
        )}
      </Field>
    );
  }

  const set = (part: 'year' | 'month' | 'day', raw: number) => {
    const next = { ...bs, [part]: raw };
    const cap = bsDaysInMonth(next.year, next.month);
    if (next.day > cap) next.day = cap;
    try {
      const iso = bsToAd(next.year, next.month, next.day);
      if (max && iso > max) return;
      onChange(iso);
    } catch { /* out of range — leave the previous value in place */ }
  };

  const years: number[] = [];
  for (let y = Math.max(BS_MIN_YEAR, bs.year - 3); y <= Math.min(BS_MAX_YEAR, bs.year + 1); y += 1) years.push(y);

  return (
    <div className="space-y-1">
      <label htmlFor={yearId} className="block text-[13px] leading-[18px] font-medium text-[var(--label-secondary)]">
        {label}{required && <span className="text-[var(--destructive)] ml-0.5" aria-hidden="true">*</span>}
        <span className="ml-1 font-normal text-[var(--label-tertiary)]">(Bikram Sambat)</span>
      </label>
      <div className="grid grid-cols-3 gap-1.5">
        <select id={yearId} aria-label={`${label} year`} value={bs.year}
          onChange={(e) => set('year', Number(e.target.value))} className={inputClass}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select aria-label={`${label} month`} value={bs.month}
          onChange={(e) => set('month', Number(e.target.value))} className={inputClass}>
          {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select aria-label={`${label} day`} value={bs.day}
          onChange={(e) => set('day', Number(e.target.value))} className={inputClass}>
          {Array.from({ length: bsDaysInMonth(bs.year, bs.month) }, (_, i) => i + 1)
            .map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <p className="text-[13px] text-[var(--label-tertiary)]">{formatAd(value, 'long')}</p>
    </div>
  );
};

export const DualDate: React.FC<{ iso: string; calendar: 'BS' | 'AD'; className?: string }> = ({ iso, calendar, className = '' }) => {
  const bs = useMemo(() => { try { return adToBs(iso); } catch { return null; } }, [iso]);
  if (calendar === 'AD' || !bs) return <span className={`tabular-nums ${className}`}>{iso}</span>;
  return (
    <span className={`tabular-nums ${className}`} title={`${iso} AD`}>
      {bs.year}-{String(bs.month).padStart(2, '0')}-{String(bs.day).padStart(2, '0')}
    </span>
  );
};

/* -------------------------------------------------------------------------- */
/* Searchable, paginated table                                                 */
/* -------------------------------------------------------------------------- */

export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: string;
  render: (row: T) => React.ReactNode;
}

export function DataTable<T extends { id: string }>({
  rows, columns, searchKeys, searchPlaceholder = 'Search', pageSize = 25, empty, onRowClick,
}: {
  rows: T[];
  columns: Column<T>[];
  searchKeys: (row: T) => string;
  searchPlaceholder?: string;
  pageSize?: number;
  empty: React.ReactNode;
  onRowClick?: (row: T) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const searchId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchKeys(r).toLowerCase().includes(q));
  }, [rows, query, searchKeys]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = useMemo(
    () => filtered.slice(safePage * pageSize, safePage * pageSize + pageSize),
    [filtered, safePage, pageSize],
  );

  const go = useCallback((delta: number) => setPage((p) => Math.max(0, Math.min(pageCount - 1, p + delta))), [pageCount]);

  if (rows.length === 0) return <>{empty}</>;

  return (
    <div className="space-y-3">
      <div className="relative max-w-xs">
        <Search size={14} strokeWidth={1.8} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--label-secondary)]" aria-hidden="true" />
        <input
          id={searchId} type="search" value={query} placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          className={`${inputClass} pl-8`}
        />
      </div>

      <div className="overflow-x-auto border border-[var(--separator)] rounded-[12px] bg-[var(--bg)]">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--bg-secondary)]/80 text-[var(--label-secondary)] border-b border-[var(--separator)]">
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col"
                  className={`py-3 px-3 font-medium whitespace-nowrap min-h-[44px] ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                  style={c.width ? { width: c.width } : undefined}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--separator)]/30">
            {visible.map((row) => (
              <tr
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                className={onRowClick ? 'cursor-pointer hover:bg-[var(--fill-secondary)] focus:bg-[var(--fill-secondary)]' : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`py-3 px-3 min-h-[44px] ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-[13px] text-[var(--label-secondary)]">
        <p aria-live="polite">
          {filtered.length === 0
            ? `Nothing matches "${query}"`
            : `${safePage * pageSize + 1}–${Math.min(filtered.length, (safePage + 1) * pageSize)} of ${filtered.length}`}
        </p>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={() => go(-1)} disabled={safePage === 0} aria-label="Previous page">
              <ChevronLeft size={14} strokeWidth={1.8} aria-hidden="true" />
            </Button>
            <span className="tabular-nums px-1">{safePage + 1} / {pageCount}</span>
            <Button variant="ghost" onClick={() => go(1)} disabled={safePage >= pageCount - 1} aria-label="Next page">
              <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export const todayIso = todayNpt;
