# Zeyks Book implementation audit

Reviewed against the current source, Neon migrations, and offline test suite on 2026-10-31. This is a code audit, not a live production database, provider, or backup verification.

| Area | Status | Existing implementation and remaining work |
|---|---|---|
| Authentication and profiles | PARTIAL | Neon Auth sign-in and profile claiming exist. Google provider credentials and production callbacks must be verified in Neon. New profiles default to `user`. Migration 028 archives superseded profile rows after relinking references. |
| Plans and staff access | PARTIAL | `profiles.role` holds `user`, `plus`, or `premium`; `profiles.is_staff` separately protects `/king`. Upgrade checkout is not wired. Plus/Premium are assigned through the database. |
| Starter data access | FIXED IN SOURCE | Starter can read only businesses where the user has a membership. UI mutations and sensitive report exports are disabled; database write checks remain required. Migration 027 must be applied to production. |
| Plus/Premium authorization | PARTIAL | Neon RPCs and RLS enforce accounting writes and Premium inventory operations. Migration 027 adds a database-side one-business limit for Plus. A complete capability-by-capability audit and team permissions remain. |
| Double-entry accounting | PARTIAL | Chart of accounts, atomic posting RPCs, debit/credit constraints, reversals, trial balance, and integrity checks exist. Independent accounting review and additional period close/open workflows remain. |
| Sales, purchases, invoices, payments | PARTIAL | Sales, purchases, expenses, invoices/bills, settlements, partial payments, void/reversal flows, and gateway verification exist. Quotes, credit/debit notes, refunds, and provider webhooks remain absent. |
| Customers and suppliers | PARTIAL | Names and balances are carried through documents and aging reports. A dedicated contact directory, statements, and consent-based reminders are not complete. |
| Inventory | PARTIAL | Product records, stock movements, valuation views, low-stock data, and Premium write checks exist. Returns and inventory-to-accounting cases need further review. |
| Cash, bank, reconciliation | PARTIAL | Migration 029 adds bank statement lines, ledger matching, and a balance-checked reconciliation workflow. CSV statement import remains. |
| Budgets and recurring work | PARTIAL | Migration 029 adds account-period budgets and review-before-posting recurring invoices through the existing sale RPC. Automatic background scheduling and budget variance reports remain. |
| Financial reports | PARTIAL | Statements, ledger, sales/purchase/expense, aging, cash/bank, and VAT summary reports exist. Budget variance, cash flow, and several advanced reports remain. |
| Nepal date and tax support | PARTIAL | BS/AD conversion, fiscal periods, NPR formatting, and configurable VAT calculations exist. Current legal tax behavior has not been verified against authoritative rules. |
| Import and export | PARTIAL | JSON backup export and report CSV/print exist; Starter exports are now disabled. Validated import preview and import rollback are absent. |
| Backups and recovery | NOT VERIFIED | The app can export JSON, but no scheduled encrypted backup/restore workflow or restore test is present in the application source. Neon infrastructure retention/PITR settings need separate verification. |
| Businesses and teams | PARTIAL | Business membership and OWNER/ACCOUNTANT/VIEWER checks exist. Premium multi-business switching, invitations, and team management UI are incomplete. |
| Audit and security | PARTIAL | RLS, server-side posting, idempotency, and immutable reversal history exist. A full activity log, upload controls, and complete capability audit remain. |
| Fixed assets and documents | PARTIAL | Migration 029 adds a fixed-asset register, monthly straight-line depreciation postings, and private small-file attachments. Full document previews and larger object storage remain. |
| Dashboard and offline use | PARTIAL | The dashboard and read-only offline cache exist. Starter empty states and available actions must remain clear and read-only. |

## Data-preservation boundary

Migrations 027–029 were applied to production Neon branch `br-solitary-lab-b3ikmr0t` on 2026-10-31 after explicit approval. The eight new Premium tables and their row-level security were verified, and sampled row counts for existing profiles, businesses, memberships, sales, expenses, payments, and journal data were unchanged. The Neon Data API schema cache was also refreshed after the app reported that `public.budgets` was missing. Migration 027 replaces membership and read policies and adds a `BEFORE INSERT` business-plan guard; it does not remove existing business or ledger rows. Migration 028 adds `profiles.archived_at`, retains superseded profile rows after relinking references, and replaces the legacy erase RPC with an exception plus revoked app-role access. Migration 029 adds Premium module tables, scoped policies, and server-side posting/matching functions; it does not change existing rows. Migration 030 (included in this code push) moves author references in those Premium tables when an account is relinked; it does not delete or alter accounting data. Apply it to production before relying on the updated profile-relinking behavior. Migrations 027–030 contain no row deletion, truncation, or table drop. Keep a verified database backup before future production schema changes.
