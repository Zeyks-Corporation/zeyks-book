import React from 'react';
import { BusinessProfile } from '../types';
import { formatNpr } from '../lib/money';
import { adToBs, formatAd, formatBs, todayNpt } from '../lib/nepaliDate';
import type { ReportMetaRow } from '../services/reportData';

/** Re-exported so a report imports its header meta rows from one place. */
export type { ReportMetaRow };

/**
 * The report and document design language.
 *
 * Every statement, every report table and every printable document is built out
 * of these pieces, so there is one typography scale, one table rule and one
 * footer instead of six designs that drift apart. The styling lives in
 * `index.css` (`.report-*`); this file only decides structure, and it holds no
 * financial logic — figures arrive already computed by `accountingEngine` or
 * `reportData`.
 *
 * Everything here prints. The sheet is a real 210mm × 297mm page on screen and
 * becomes the whole print job via `@page` in the stylesheet, which is why the
 * header and footer are ordinary elements rather than a print-only overlay.
 */

/* -------------------------------------------------------------------------- */
/* Paper conventions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one currency label the document system prints.
 *
 * The app header can toggle between the `NPR` and `रू` symbols for screen use,
 * but a printed statement must not mix them: paper goes to a bank, an auditor or
 * the IRD, and an ISO code is unambiguous on all three. Reports and documents
 * therefore always print `NPR`, whatever the on-screen toggle says.
 */
export const REPORT_CURRENCY = 'NPR';

export function reportMoney(value: number): string {
  return formatNpr(value, REPORT_CURRENCY);
}

/** Date as the selected calendar shows it, with the other calendar beside it. */
export function reportDate(iso: string, calendar: 'BS' | 'AD'): string {
  try {
    if (calendar === 'BS') return `${formatBs(adToBs(iso))} BS · ${formatAd(iso)} AD`;
    return `${formatAd(iso)} · ${formatBs(adToBs(iso))} BS`;
  } catch {
    // Outside the supported BS span (before 1943-04-13) the AD date still prints.
    return iso;
  }
}

/** Compact date for a table column: the calendar being read, and nothing else. */
export function reportShortDate(iso: string, calendar: 'BS' | 'AD'): string {
  if (calendar === 'AD') return iso;
  try {
    return `${formatBs(adToBs(iso))} BS`;
  } catch {
    return iso;
  }
}

/**
 * When this sheet was produced, as a real date — never a hard-coded one.
 * Shown in both calendars so a filed copy can be matched to either register.
 */
export function reportStamp(generatedOn: string = todayNpt()): string {
  try {
    return `${formatAd(generatedOn, 'long')} (BS ${formatBs(adToBs(generatedOn))})`;
  } catch {
    return generatedOn;
  }
}

/* -------------------------------------------------------------------------- */
/* Sheet, header, footer                                                       */
/* -------------------------------------------------------------------------- */

/** A4 portrait page. One sheet per report, or per printed document. */
export const ReportSheet: React.FC<{ children: React.ReactNode; id?: string }> = ({ children, id }) => (
  <div className="report-scroll">
    <div id={id} className="report-sheet" data-report-sheet>
      {children}
    </div>
  </div>
);

/**
 * Business block plus the report's own title and period.
 *
 * Only fields the business actually stores are printed: no invented address,
 * registration number, bank name or tax detail ever reaches the page. An empty
 * business profile prints simply as "Your business" with nothing beneath it.
 */
export const ReportHeader: React.FC<{
  business: BusinessProfile;
  title: string;
  subtitle: string;
  meta?: ReportMetaRow[];
  calendar: 'BS' | 'AD';
  fiscalYearLabel?: string;
}> = ({ business, title, subtitle, meta = [], calendar, fiscalYearLabel }) => {
  const cityLine = [business.address, business.city].filter((v) => v && v.trim()).join(', ');
  const contact = [
    business.phone && `Phone ${business.phone}`,
    business.email && business.email,
    business.panNumber && `PAN ${business.panNumber}`,
  ].filter(Boolean) as string[];

  return (
    <header className="report-block">
      <div className="flex items-start justify-between gap-8">
        <div className="min-w-0">
          <p className="report-kicker">Zeyks Book</p>
          <p className="report-business mt-0.5">{business.businessName || 'Your business'}</p>
          {cityLine && <p className="report-identity">{cityLine}</p>}
          {contact.length > 0 && <p className="report-identity">{contact.join(' · ')}</p>}
        </div>
        <div className="text-right shrink-0">
          {fiscalYearLabel && (
            <p className="report-identity">Fiscal year {fiscalYearLabel}</p>
          )}
          <p className="report-identity">
            {business.vatRegistered ? `VAT registered · ${business.vatRate}%` : 'Not VAT registered'}
          </p>
          <p className="report-identity">{calendar === 'BS' ? 'Bikram Sambat dates' : 'Gregorian dates'}</p>
          <p className="report-identity">Amounts in {REPORT_CURRENCY}</p>
        </div>
      </div>

      <div className="report-rule-strong mt-4 pt-3">
        <h2 className="report-title">{title}</h2>
        <p className="report-subtitle mt-0.5">{subtitle}</p>
      </div>

      {meta.length > 0 && (
        <dl className="report-meta report-rule mt-3 pt-3">
          {meta.map((row) => (
            <div key={row.label} className="flex gap-1.5">
              <dt className="report-meta-key">{row.label}</dt>
              <dd className="report-meta-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
};

/**
 * Restrained footer.
 *
 * Page numbers are deliberately absent: no browser can count printed pages from
 * CSS, and inventing "Page 1 of 1" would be a lie about a multi-page ledger. The
 * stylesheet declares `@page` margin boxes so a paged-media engine that *can*
 * count pages prints them; in a browser the print dialog's own header/footer
 * does the job, and this footer carries the real generation date.
 */
export const ReportFooter: React.FC<{ generatedOn?: string; note?: string; right?: string }> = ({
  generatedOn = todayNpt(), note, right,
}) => (
  <footer className="report-footer">
    <span>{note ?? 'Generated from posted records'}</span>
    <span>{right ?? `Generated on ${reportStamp(generatedOn)}`}</span>
  </footer>
);

/* -------------------------------------------------------------------------- */
/* Body pieces                                                                 */
/* -------------------------------------------------------------------------- */

export const ReportSection: React.FC<{ title: string; children: React.ReactNode; note?: string }> = ({
  title, children, note,
}) => (
  <section className="report-block mt-5 first:mt-0">
    <h3 className="report-section-title border-b border-zinc-300 pb-1 mb-2">{title}</h3>
    {children}
    {note && <p className="report-note mt-1.5">{note}</p>}
  </section>
);

/** A labelled figure on a ruled line — the statement row shape. */
export const ReportRow: React.FC<{
  label: string; value: number; tone?: 'plain' | 'total' | 'grand' | 'quiet'; indent?: boolean;
}> = ({ label, value, tone = 'plain', indent }) => {
  const className = tone === 'grand' ? 'report-row report-row-grand'
    : tone === 'total' ? 'report-row report-row-total'
    : 'report-row';
  return (
    <div className={className}>
      <span className={`${indent ? 'pl-4' : ''} ${tone === 'quiet' ? 'text-zinc-500' : ''}`}>{label}</span>
      <span className={tone === 'quiet' ? 'text-zinc-500' : ''}>{reportMoney(value)}</span>
    </div>
  );
};

/** Money in a table cell. A zero prints as an em dash so columns stay scannable. */
export const ReportAmount: React.FC<{ value: number; dashOnZero?: boolean; quiet?: boolean }> = ({
  value, dashOnZero = true, quiet,
}) => {
  if (dashOnZero && Math.abs(value) < 0.005) {
    return <span className="report-quiet">—</span>;
  }
  return <span className={quiet ? 'report-quiet' : undefined}>{reportMoney(value)}</span>;
};

export interface ReportColumn<T> {
  key: string;
  header: string;
  /** Right-aligned, tabular figures. */
  numeric?: boolean;
  /** Text rendered in the quiet grey used for secondary columns. */
  quiet?: boolean;
  render: (row: T) => React.ReactNode;
}

/**
 * A report table. `<thead>` repeats on every printed page (see `.report-table`
 * and the `@media print` rules), so a ledger that runs to five pages stays
 * readable on each of them.
 */
export function ReportTable<T>({
  columns, rows, totals, totalsLabel, label,
}: {
  columns: ReportColumn<T>[];
  rows: T[];
  totals?: Record<string, React.ReactNode>;
  totalsLabel?: string;
  label: string;
}): React.ReactElement {
  return (
    <table className="report-table" aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} scope="col" className={c.numeric ? 'report-num' : undefined}>{c.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          // Rows here are already-shaped display rows, so the index disambiguates
          // two ledger lines that share an entry and an account.
          <tr key={`${i}-${columns[0]?.key ?? 'row'}`}>
            {columns.map((c) => (
              <td key={c.key} className={c.numeric ? 'report-num' : c.quiet ? 'report-quiet' : undefined}>
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
      {totals && (
        <tfoot>
          <tr>
            {columns.map((c, i) => (
              <td key={c.key} className={c.numeric ? 'report-num' : undefined}>
                {i === 0 ? (totalsLabel ?? 'Total') : totals[c.key] ?? null}
              </td>
            ))}
          </tr>
        </tfoot>
      )}
    </table>
  );
}

/**
 * The professional empty state. The sheet's header above it still states the
 * business, the report and the period, so an empty report reads as a real
 * statement of "nothing happened" rather than a broken screen.
 */
export const ReportEmpty: React.FC<{
  title?: string; detail?: string; children?: React.ReactNode;
}> = ({ title = 'No financial transactions have been recorded for this period.', detail, children }) => (
  <div className="report-empty report-block mt-6">
    <p>{title}</p>
    {detail && <p className="report-note mt-1.5">{detail}</p>}
    {children}
  </div>
);

export const ReportNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="report-note mt-2">{children}</p>
);

/** Key/value block used on a printed document (party, payment, status). */
export const ReportBlock: React.FC<{
  title: string; rows: { label: string; value: React.ReactNode }[]; children?: React.ReactNode;
}> = ({ title, rows, children }) => (
  <section className="report-block mt-5 first:mt-0">
    <h3 className="report-section-title border-b border-zinc-300 pb-1 mb-2">{title}</h3>
    <dl className="space-y-0.5">
      {rows.map((r) => (
        <div key={r.label} className="flex gap-2 text-[8.5pt]">
          <dt className="report-meta-key min-w-[8rem]">{r.label}</dt>
          <dd className="report-meta-value">{r.value}</dd>
        </div>
      ))}
    </dl>
    {children}
  </section>
);

/** POSTED / VOID / PAID / PARTIAL / UNPAID, from persisted state only. */
export const ReportStatus: React.FC<{ label: string; tone?: 'ok' | 'warn' | 'neutral' }> = ({
  label, tone = 'neutral',
}) => {
  const tones = {
    ok: 'text-emerald-700 border-emerald-300',
    warn: 'text-amber-700 border-amber-300',
    neutral: 'text-zinc-600 border-zinc-300',
  };
  return (
    <span className={`inline-block border px-1.5 py-0.5 text-[7.5pt] font-semibold tracking-wide uppercase ${tones[tone]}`}>
      {label}
    </span>
  );
};
