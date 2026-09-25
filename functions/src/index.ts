/**
 * Zeyks Book — Cloud Functions entrypoint.
 *
 * Every export becomes a callable endpoint. Grouped by concern:
 *   auth.ts     — requestOtp / verifyOtp (passwordless email sign-in)
 *   posting.ts  — postJournal / voidDocument / seedChartIfEmpty (the ledger)
 *   business.ts — createBusiness / updateBusiness (tenant lifecycle)
 */

export { requestOtp, verifyOtp } from './auth';
export { postJournal, voidDocument, seedChartIfEmpty, closeFiscalYear } from './posting';
export { createBusiness, updateBusiness } from './business';

