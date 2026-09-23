/**
 * Document numbering.
 *
 * The old generator used `matching.length + 1`, so voiding a document made the
 * next one reuse a number that had already been issued. Numbering now advances
 * from the highest sequence ever seen, voided documents included, which is what
 * an audit trail requires.
 *
 * Format: PREFIX-YYYYMMDD-NNN, using the Kathmandu date rather than UTC.
 */

import { todayNpt } from '../lib/nepaliDate';

export type RefKind = 'INV' | 'PO' | 'EXP' | 'PAY' | 'RCP';

const dateKey = (isoDate: string): string => isoDate.replace(/-/g, '');

export function nextReference(kind: RefKind, existing: string[], onDate = todayNpt()): string {
  const prefix = `${kind}-${dateKey(onDate)}-`;
  let highest = 0;
  for (const ref of existing) {
    if (!ref?.startsWith(prefix)) continue;
    const seq = Number.parseInt(ref.slice(prefix.length), 10);
    if (Number.isFinite(seq) && seq > highest) highest = seq;
  }
  return `${prefix}${String(highest + 1).padStart(3, '0')}`;
}

/** Journal entries carry a monotonic sequence so same-day rows order correctly. */
export function nextSequence(entries: { sequence: number }[]): number {
  return entries.reduce((max, e) => Math.max(max, e.sequence ?? 0), 0) + 1;
}
