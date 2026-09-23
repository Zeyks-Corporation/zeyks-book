/**
 * Money helpers. Every amount in Zeyks Book is NPR held as a JS number in
 * rupees. All arithmetic that lands in the ledger goes through `round2` so
 * floating-point dust never accumulates across entries.
 */

export function round2(value: number): number {
  // Math.round(x * 100) alone mis-rounds cases like 1.005; the epsilon nudge
  // pushes values that are a hair under the .5 boundary back onto it.
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON * Math.sign(value) * Math.abs(value)) * 100) / 100;
}

export function toPaisa(rupees: number): number {
  return Math.round(round2(rupees) * 100);
}

export function fromPaisa(paisa: number): number {
  return round2(paisa / 100);
}

/** Parse user input leniently but never return NaN. */
export function parseAmount(input: string | number | null | undefined): number {
  if (typeof input === 'number') return Number.isFinite(input) ? round2(input) : 0;
  if (!input) return 0;
  const cleaned = String(input).replace(/[,\s\u0930\u0942A-Za-z]/g, '');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? round2(parsed) : 0;
}

/**
 * Financial columns always show exactly two decimals so figures line up.
 * Grouping follows the lakh/crore convention used in Nepal.
 */
export function formatNpr(value: number, symbol = 'NPR', opts: { decimals?: boolean } = {}): string {
  const decimals = opts.decimals !== false;
  const safe = Number.isFinite(value) ? value : 0;
  const negative = safe < 0;
  const body = Math.abs(safe).toLocaleString('en-IN', {
    minimumFractionDigits: decimals ? 2 : 0,
    maximumFractionDigits: decimals ? 2 : 0,
  });
  const prefix = symbol === 'रू' ? 'रू ' : `${symbol} `;
  return `${negative ? '-' : ''}${prefix}${body}`;
}

/** Compact form for chart axes, where two decimals are noise. */
export function formatCompactNpr(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${round2(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}${round2(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}${Math.round(abs / 1e3)}K`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Split a VAT-inclusive or VAT-exclusive figure into net + tax.
 * Nepal's standard VAT rate is 13%.
 */
export function splitVat(amount: number, ratePercent: number, inclusive: boolean): { net: number; tax: number; gross: number } {
  const rate = ratePercent / 100;
  if (rate <= 0) return { net: round2(amount), tax: 0, gross: round2(amount) };
  if (inclusive) {
    const net = round2(amount / (1 + rate));
    return { net, tax: round2(amount - net), gross: round2(amount) };
  }
  const tax = round2(amount * rate);
  return { net: round2(amount), tax, gross: round2(amount + tax) };
}
