/**
 * Bikram Sambat <-> Gregorian conversion, plus Nepali fiscal-year helpers.
 *
 * Anchor: BS 2000-01-01 === AD 1943-04-13.
 * Verified against published Nepali New Year dates for BS 2078-2086 and
 * round-trip tested across the whole supported span (see tests/run.mjs).
 *
 * Supported range: BS 2000 - 2090 (AD 1943-04-13 to roughly 2034-04).
 */

export const BS_MIN_YEAR = 2000;
export const BS_MAX_YEAR = 2090;

/** Days in each of the 12 BS months, per BS year. */
const BS_CALENDAR: Record<number, number[]> = {
  2000: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], 2001: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2002: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2003: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2004: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31], 2005: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2006: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2007: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2008: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 29, 31], 2009: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2010: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2011: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2012: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30], 2013: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2014: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2015: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2016: [31, 31, 31, 32, 31, 31, 29, 30, 30, 29, 30, 30], 2017: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2018: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2019: [31, 32, 31, 32, 31, 30, 30, 30, 29, 30, 29, 31],
  2020: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2021: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2022: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2023: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2024: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2025: [31, 31, 32, 32, 30, 31, 30, 29, 30, 29, 30, 30],
  2026: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2027: [30, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2028: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2029: [31, 31, 32, 31, 32, 30, 30, 29, 30, 29, 30, 30],
  2030: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2031: [30, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2032: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2033: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2034: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2035: [30, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2036: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2037: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2038: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2039: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2040: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2041: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2042: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2043: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2044: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2045: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2046: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2047: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2048: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2049: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2050: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2051: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2052: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30], 2053: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30],
  2054: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31], 2055: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30],
  2056: [31, 31, 32, 31, 31, 31, 30, 30, 29, 29, 30, 30], 2057: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2058: [30, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2059: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2060: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2061: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2062: [30, 32, 31, 32, 31, 31, 30, 29, 30, 29, 30, 31], 2063: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2064: [31, 31, 32, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2065: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2066: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2067: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2068: [31, 31, 32, 32, 30, 31, 30, 30, 29, 29, 30, 30], 2069: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2070: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2071: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2072: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2073: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2074: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2075: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2076: [31, 32, 31, 32, 31, 30, 30, 29, 30, 29, 30, 30], 2077: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 31],
  2078: [31, 31, 31, 32, 31, 31, 30, 29, 30, 29, 30, 30], 2079: [31, 31, 32, 31, 31, 31, 30, 29, 30, 29, 30, 30],
  2080: [31, 32, 31, 32, 31, 30, 30, 30, 29, 29, 30, 30], 2081: [31, 31, 32, 32, 31, 30, 30, 30, 29, 30, 30, 30],
  2082: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30], 2083: [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30],
  2084: [31, 31, 32, 31, 31, 30, 30, 30, 29, 30, 30, 30], 2085: [31, 32, 31, 32, 30, 31, 30, 30, 29, 30, 30, 30],
  2086: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30], 2087: [31, 31, 32, 31, 31, 31, 30, 30, 29, 30, 30, 30],
  2088: [30, 31, 32, 32, 30, 31, 30, 30, 29, 30, 30, 30], 2089: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30],
  2090: [30, 32, 31, 32, 31, 30, 30, 30, 29, 30, 30, 30],
};

export const BS_MONTHS = [
  'Baisakh', 'Jestha', 'Ashadh', 'Shrawan', 'Bhadra', 'Ashoj',
  'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra',
] as const;

export const BS_MONTHS_NP = [
  'बैशाख', 'जेठ', 'असार', 'श्रावण', 'भदौ', 'असोज',
  'कार्तिक', 'मंसिर', 'पुष', 'माघ', 'फाल्गुन', 'चैत्र',
] as const;

export interface BsDate { year: number; month: number; day: number }

const MS_PER_DAY = 86_400_000;
const EPOCH_AD_UTC = Date.UTC(1943, 3, 13); // BS 2000-01-01

export function bsDaysInMonth(year: number, month: number): number {
  const row = BS_CALENDAR[year];
  if (!row) throw new RangeError(`BS year ${year} is outside the supported ${BS_MIN_YEAR}-${BS_MAX_YEAR} range.`);
  const days = row[month - 1];
  if (days === undefined) throw new RangeError(`BS month must be 1-12, received ${month}.`);
  return days;
}

/** 'YYYY-MM-DD' (AD) -> BS date. */
export function adToBs(value: string): BsDate {
  const iso = assertIsoDate(value, 'a Bikram Sambat conversion');
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) throw new RangeError(`AD date ${iso} is not a real date.`);
  let remaining = Math.round((Date.UTC(y, m - 1, d) - EPOCH_AD_UTC) / MS_PER_DAY);
  if (remaining < 0) throw new RangeError(`${iso} falls before BS ${BS_MIN_YEAR}-01-01 and cannot be converted.`);

  let year = BS_MIN_YEAR;
  let month = 1;
  let day = 1;
  while (remaining > 0) {
    const daysLeftInMonth = bsDaysInMonth(year, month) - day + 1;
    if (remaining < daysLeftInMonth) {
      day += remaining;
      remaining = 0;
    } else {
      remaining -= daysLeftInMonth;
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
        if (year > BS_MAX_YEAR) throw new RangeError(`${iso} falls past BS ${BS_MAX_YEAR} and cannot be converted.`);
      }
    }
  }
  return { year, month, day };
}

/** BS date -> 'YYYY-MM-DD' (AD). */
export function bsToAd(year: number, month: number, day: number): string {
  if (year < BS_MIN_YEAR || year > BS_MAX_YEAR) {
    throw new RangeError(`BS year ${year} is outside the supported ${BS_MIN_YEAR}-${BS_MAX_YEAR} range.`);
  }
  if (day < 1 || day > bsDaysInMonth(year, month)) {
    throw new RangeError(`${BS_MONTHS[month - 1]} ${year} has ${bsDaysInMonth(year, month)} days; ${day} is out of range.`);
  }
  let days = 0;
  for (let y = BS_MIN_YEAR; y < year; y += 1) {
    days += BS_CALENDAR[y]!.reduce((a, b) => a + b, 0);
  }
  for (let m = 1; m < month; m += 1) days += bsDaysInMonth(year, m);
  days += day - 1;

  const dt = new Date(EPOCH_AD_UTC + days * MS_PER_DAY);
  return toIsoUtc(dt);
}

/**
 * A `YYYY-MM-DD` date, or an error that says which value was wrong.
 *
 * Every date entry point below goes through this, because of a real production
 * failure: a document row arrived without its `due_date`, the value travelled
 * into `undefined.split('-')` inside these formatters, and the application died
 * with `Cannot read properties of undefined (reading 'split')` — a message that
 * names neither the field nor the screen. The date is still refused; it is now
 * refused with the name of the thing that was missing.
 *
 * `context` is what the caller was doing, so a stack trace is not required to
 * find out where the bad value came from.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || month === undefined || day === undefined || month < 1 || month > 12 || day < 1) return false;
  const actualDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= actualDays;
}

export function assertIsoDate(value: unknown, context: string): string {
  if (isIsoDate(value)) return value;
  const shown = value === undefined
    ? 'undefined'
    : value === null
      ? 'null'
      : typeof value === 'string' ? JSON.stringify(value) : String(value);
  throw new TypeError(`Expected a date as YYYY-MM-DD for ${context}, received ${shown}.`);
}

function toIsoUtc(dt: Date): string {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Today in Asia/Kathmandu as 'YYYY-MM-DD'. Never drifts to the UTC day. */
export function todayNpt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function todayBs(): BsDate {
  return adToBs(todayNpt());
}

export function formatBs(bs: BsDate, style: 'short' | 'long' = 'short'): string {
  if (style === 'long') return `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`;
  return `${bs.year}-${String(bs.month).padStart(2, '0')}-${String(bs.day).padStart(2, '0')}`;
}

export function formatAd(value: string, style: 'short' | 'long' = 'short'): string {
  const iso = assertIsoDate(value, 'a Gregorian date');
  if (style === 'short') return iso;
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/* -------------------------------------------------------------------------- */
/* Fiscal year                                                                 */
/* -------------------------------------------------------------------------- */

export interface FiscalYear {
  /** BS year the fiscal year opens in, e.g. 2083 for FY 2083/84. */
  bsYear: number;
  /** Display label, e.g. "2083/84". */
  label: string;
  /** Inclusive AD start date, 'YYYY-MM-DD'. */
  startAd: string;
  /** Inclusive AD end date, 'YYYY-MM-DD'. */
  endAd: string;
}

/**
 * Nepal's statutory fiscal year runs Shrawan 1 to the last day of Ashadh.
 * `startMonth` is configurable so a business on a non-standard year (or one
 * reporting on the AD calendar) can still use the same machinery.
 */
export function fiscalYearFor(bsYear: number, startMonth = 4): FiscalYear {
  const startAd = bsToAd(bsYear, startMonth, 1);
  const endBsYear = startMonth === 1 ? bsYear : bsYear + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endAd = bsToAd(endBsYear, endMonth, bsDaysInMonth(endBsYear, endMonth));
  const shortNext = String((bsYear + 1) % 100).padStart(2, '0');
  return {
    bsYear,
    label: startMonth === 1 ? `${bsYear}` : `${bsYear}/${shortNext}`,
    startAd,
    endAd,
  };
}

/** The fiscal year containing the given AD date. */
export function fiscalYearOf(iso: string, startMonth = 4): FiscalYear {
  const bs = adToBs(iso);
  const bsYear = bs.month >= startMonth ? bs.year : bs.year - 1;
  return fiscalYearFor(bsYear, startMonth);
}

/** Recent fiscal years, newest first — for the report period picker. */
export function recentFiscalYears(count = 5, startMonth = 4, from = todayNpt()): FiscalYear[] {
  const current = fiscalYearOf(from, startMonth);
  const out: FiscalYear[] = [];
  for (let i = 0; i < count; i += 1) {
    const year = current.bsYear - i;
    if (year < BS_MIN_YEAR || year + 1 > BS_MAX_YEAR) break;
    out.push(fiscalYearFor(year, startMonth));
  }
  return out;
}

/** Inclusive AD bounds of a whole BS month — for month-by-month reporting. */
export function bsMonthRange(bsYear: number, bsMonth: number): { startAd: string; endAd: string; label: string } {
  return {
    startAd: bsToAd(bsYear, bsMonth, 1),
    endAd: bsToAd(bsYear, bsMonth, bsDaysInMonth(bsYear, bsMonth)),
    label: `${BS_MONTHS[bsMonth - 1]} ${bsYear}`,
  };
}

/** Shift an AD ISO date by whole days without tripping over local time zones. */
export function addDays(value: string, days: number): string {
  const iso = assertIsoDate(value, 'a date shift');
  const [y, m, d] = iso.split('-').map(Number);
  return toIsoUtc(new Date(Date.UTC(y!, m! - 1, d!) + days * MS_PER_DAY));
}

/** Inclusive string comparison is safe because ISO dates sort lexicographically. */
export function isWithin(iso: string, from?: string, to?: string): boolean {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}
