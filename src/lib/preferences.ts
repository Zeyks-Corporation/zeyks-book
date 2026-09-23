/**
 * Display preferences that belong to the person, not to the books.
 *
 * Which calendar a date is *written* in is a reading preference: the same
 * instant is the same instant, and switching the display changes no stored
 * value, no journal amount and no report figure. It is therefore kept on the
 * device rather than in the database — unlike the currency symbol and the
 * fiscal-year start, which are facts about the business and are stored on the
 * business record.
 *
 * Every read is guarded: a browser that refuses storage (private mode, a
 * blocked origin) must fall back to the default rather than throw on startup.
 */

export type CalendarPreference = 'BS' | 'AD';

/** Nepal's convention is the default: Bikram Sambat, with the AD date beside it. */
export const DEFAULT_CALENDAR: CalendarPreference = 'BS';

const CALENDAR_KEY = 'zeyks.calendar';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCalendarPreference(): CalendarPreference {
  try {
    const raw = storage()?.getItem(CALENDAR_KEY);
    return raw === 'AD' || raw === 'BS' ? raw : DEFAULT_CALENDAR;
  } catch {
    return DEFAULT_CALENDAR;
  }
}

export function writeCalendarPreference(value: CalendarPreference): void {
  try {
    storage()?.setItem(CALENDAR_KEY, value);
  } catch {
    /* Non-fatal: the preference applies for this session and is not remembered. */
  }
}
