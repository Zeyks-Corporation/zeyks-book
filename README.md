      # Zeyks Book   
            
Double-entry accounting for Nepali small businesses — sales, purchases,
expenses, VAT, and online collection through eSewa and Khalti. Dates work in
both Bikram Sambat and the Gregorian calendar, and the fiscal year follows
Nepal's Shrawan–Ashadh year by default.           
   
## What changed from v1            
   
This is a rewrite, not a patch. The previous build had no way to filter a
report to a period (every statement silently covered *all* transactions),     
no way to edit or void a mistake, a "balanced" indicator that could never    
show unbalanced, and no VAT, inventory, or fiscal year support. All of that
is addressed here — see `CHANGES` in git history / the original code review
for the full list if you still have it.

## Stack

React 19 + TypeScript + Vite + Tailwind v4 on the frontend, Firebase for
authentication and cloud storage, and a small Express server for payment
gateway calls. The browser talks to Firebase with the publishable (anon) key
only; RLS restricts every row to the signed-in user's businesses.

## Getting started

You need Node 20+, the [Firebase CLI](https://firebase.com/docs/guides/cli) and
a running Docker. **A new contributor never needs a production or staging
credential**: the local stack is the target for every command below.

```bash
npm install
firebase start                     # the local stack — the only database local work uses
cp .env.example .env               # server secrets; the sandbox eSewa test values are already there
# Now put the *browser* config in .env.local, with the values `firebase status` prints:
#   VITE_FIREBASE_URL="http://127.0.0.1:54321"
#   VITE_FIREBASE_PUBLISHABLE_KEY="<publishable (anon) key>"
firebase db reset --local          # apply migrations 001-015 to the local database
npm run dev                        # Vite dev server (3000) and the API (4000) together
```

The app tells you which database it is talking to as it starts:
`[Zeyks Book] Firebase target: local (127.0.0.1:54321)`. If it does not say
`local`, stop and read the next section — see *Environment safety*.

Open `http://localhost:3000`. Sign in or create an account, then the first
screen asks for your business name; everything else can be changed later in
Settings.

Other scripts:

```bash
npm run build     # typecheck + production build
npm run start      # serve the built app from the API server (after npm run build)
npm test            # offline test suite — calendar, ledger, posting rules
npm run lint       # typecheck only
```

## Environment safety — read before pointing anything anywhere

The browser clients require explicit `VITE_FIREBASE_*` and `VITE_SUPABASE_*`
values; there is no hard-coded production fallback. Start Firebase Auth,
Firestore and Functions emulators for local development and set
`VITE_USE_FIREBASE_EMULATORS="true"`. The Supabase URL must also be local
(`localhost` or `127.0.0.1`). This checkout does not contain a Supabase schema
or migration setup, so a local Supabase database requires separate provisioning.

`src/lib/envGuard.ts` refuses a remote Firebase or Supabase target in a
development build unless `VITE_ALLOW_REMOTE_IN_DEV="yes"` is explicitly set.
Only use that override with a reviewed staging project. The Vite config rejects
service-role-shaped keys in any `VITE_*` variable before a build is published.

`.env.local` versus `.env`:

- **`.env.local`** — browser config. Only `VITE_*` names. Vite substitutes them
  into the bundle, so everything there is public by design; the publishable
  (anon) key belongs there, a merchant secret does not. Production builds need
  these public variables configured on the deployment host as well.
- **`.env` / deployment environment** — server values: `PAYMENT_MODE`, the
  eSewa/Khalti merchant keys, `FIREBASE_PROJECT_ID`, and Firebase Admin
  credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` on Vercel or Application Default
  Credentials locally). The shared API limiter and document lookups use
  Firestore through those credentials. Payment authorization needs
  `SUPABASE_URL` and a rotated `SUPABASE_SERVICE_ROLE_KEY`. The Supabase session
  bridge additionally needs `SUPABASE_ANON_KEY`; if it is absent, that route
  returns `503`.
  Never prefix server secrets with `VITE_`.

`.gitignore` ignores `.env` and every `.env.*` file **except** `.env.example`, so
a staging or production file cannot be committed by accident.

### Git safety

`node_modules/`, `dist/` and the environment files are not tracked. The current
source no longer contains the Supabase service-role credential, but historical
commits do contain it and the former deterministic password bridge. Treat that
credential as compromised: revoke/replace it in Supabase, update the API
environment, review access logs and active sessions, and coordinate a Git
history rewrite before sharing or publishing the repository. Source cleanup
cannot revoke a credential or remove copies already fetched. The current checkout
does not track `firebase/.temp` files. Keep environment files and generated
machine state out of Git; `.gitignore` covers the environment files and Vercel
local config.

### Live security rollout

The old Supabase service-role credential remains in historical commits. The
source changes below are not live until the provider configuration and deployments
are updated:

1. Coordinate revocation or rotation of the exposed credential in Supabase with
   the new `SUPABASE_SERVICE_ROLE_KEY` in the API deployment. Confirm the old
   credential no longer works. If the rotation also changes the public anon
   key, update `SUPABASE_ANON_KEY` and `VITE_SUPABASE_ANON_KEY` together.
2. Configure the API host with `FIREBASE_PROJECT_ID`, Firebase Admin
   credentials, `SUPABASE_URL`, the rotated service-role key, and `APP_URL` for
   payment return links. Configure the public build values
   `VITE_FIREBASE_*`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_ANON_KEY` explicitly;
   the browser no longer has built-in production fallbacks. Set
   `VITE_PAYMENT_API_URL` to the API origin only after that API and gateway keys
   are ready. Deploy this source, then check sign-in, business loading, payment
   configuration and contact in the deployed environment.
3. Deploy the Firebase callable changes and `firestore.indexes.json` so OTP
   attempt limits and limiter document TTL are live. The callable deploy needs
   the existing Resend secrets. Check a failed OTP reaches the five-attempt
   limit and a new request follows the send cooldown.
4. With the rotated service-role key, run
   `node scripts/rotate-legacy-supabase-passwords.mjs` for a count-only preview.
   `--apply` assigns random passwords to **every** Supabase Auth user in the
   project; use it only after confirming that scope. Review and revoke existing
   Supabase sessions separately.
5. Inspect live Supabase RLS policies and access logs, including owner, viewer
   and cross-business reads. This checkout has no SQL migration files or live
   database access from which to establish the deployed policy state.

## Deploying — routing, and the two runtimes

Vercel serves the static build from `dist/` and routes `/api/*` to the
serverless function in `api/index.js`, which imports `server/index.js`.
The function needs its server environment and Firebase Admin credentials in
the Vercel project. Missing Supabase admin settings disable the payment and
session routes; missing Firebase Admin access makes rate-limited API routes
return `503` until configured.

**Declare the payment API origin.** The built browser app offers online
collection only when `VITE_PAYMENT_API_URL` is set. It may be this Vercel
site's origin or a separately deployed API origin:

```bash
# In the deployment's environment (a public URL, not a secret):
VITE_PAYMENT_API_URL="https://your-site.example"
```

When this value is unset, the browser makes no payment API request and the UI
offers the manual receipt and payment flow. The serverless API route may still
exist; the browser capability flag does not prove the function is configured.

**The address bar is the route.** Screens are real paths, so a refresh, a pasted
link and the back button all work:

| Path | Screen |
|---|---|
| `/` | landing page (public) |
| `/signin` (or `/login`) | sign in / create account |
| `/dashboard` `/sales` `/purchases` `/expenses` `/payments` `/reports` `/health` `/settings` | the signed-in app |
| anything else | the 404 page |

`vercel.json` routes static files first, sends `/api/*` to the API function,
and sends other unmatched paths to `index.html`. Signed
out, a book path shows the sign-in screen *at that path*, so signing in continues
to the screen that was asked for. Signed in, `/` and `/signin` redirect to
the dashboard. Unknown paths are a 404 for everyone — never a random screen.

`public/` holds `favicon.ico` (a real multi-size ICO), `favicon.svg`,
`robots.txt` and `sitemap.xml`. The sitemap and `robots.txt` cover only the
public surface: no `/dashboard`, `/reports` or `/settings` is ever indexed.

### The deployed database version

The application refuses to open a book whose schema is behind it. If a
document's `due_date` column is absent — the deployed project ran a migration
behind the app at one point — the load fails with a message naming the column and
`firebase/migrations/015_credit_terms.sql`, rather than rendering a report
derived from a half-read row. The same applies to the integrity diagnostic: if
`public.control_account_integrity()` is not deployed (migration 014), Data health
says the check **could not run** and names the migration — it never reports an
unchecked book as healthy.

The enforcement added by `016_settlement_integrity.sql` is a **schema fact the
app depends on**, not a client behaviour: `post_payment`, `void_payment`,
`post_sale`, `post_purchase`, `void_document` and `settle_gateway_txn` all write
settlement rows, and a project without migration 016 is a project where a
mis-linked settlement can be stored again. Check the real state read-only before
deploying — `firebase migration list --linked` prints one column per side, and a
blank remote cell is a migration the deployment does not have:

```bash
firebase link --project-ref <ref>   # once per machine
firebase migration list --linked     # what the project has vs. what the repo has
firebase db push                     # apply the repository's migrations
```

`016` is forward-only and validation-safe on existing data: every settlement and
reversal row in the repository's own book already satisfied all three rules
before the constraint was added, which is why it is added `VALIDATED` rather than
`NOT VALID`, and it adds no column and rewrites no row.

## Payment gateways

Both eSewa and Khalti are wired through the API server in `server/`, never
through the browser — the merchant secret and HMAC signing key are read from
`.env` on the server and never sent to the client. Gateway configuration is
**not** shown in Settings: it is server deployment configuration, not a book
setting, and the browser has no business reading which secret is loaded.

- **eSewa (ePay v2)**: `.env.example` ships eSewa's own published sandbox
  credentials (`EPAYTEST` / the sandbox secret), so eSewa collection works
  immediately in sandbox mode with no account of your own. To go live, get
  your merchant product code and secret from eSewa and set
  `ESEWA_PRODUCT_CODE` / `ESEWA_SECRET_KEY`, then set `PAYMENT_MODE=live`.
- **Khalti (ePayment v2 / KPG-2)**: no public sandbox secret exists — you
  need your own test key. Sign up for a sandbox merchant account at
  <https://test-admin.khalti.com/#/join/merchant>, copy the secret key into
  `KHALTI_SECRET_KEY`, and Khalti collection will work in sandbox. Go live
  the same way as eSewa, with a live secret key from
  <https://admin.khalti.com>.

A payment is only ever written to the ledger after the **server** confirms
it directly with the gateway (eSewa's status API / Khalti's lookup
endpoint) — a browser redirect saying "success" is treated as a prompt to
go check, never as proof. Anything left unconfirmed shows up under
**Data health** with a re-check button.

## Bikram Sambat dates

The BS↔AD converter (`src/lib/nepaliDate.ts`) is a lookup table for BS
2000–2090, anchored at BS 2000-01-01 = AD 1943-04-13. It's verified against
published Nepali New Year dates and round-trip tested across the full
range in `tests/run.mjs`. The fiscal year defaults to opening on Shrawan 1
(Nepal's statutory start) and is configurable in Settings.

## Authentication and data storage

**Authentication is Firebase Auth, and your books live in Firebase** — the
same account signs you in on any device and resolves to the same business.
Browser `localStorage` is never the source of truth for accounting data; the
only browser-side session that persists is Firebase's own auth session.

- **Settings → Backup → Export backup** downloads a JSON snapshot of your
  cloud books. Keep it somewhere safe.
- Restoring from a file, and the destructive "Erase everything" action, are
  intentionally disabled in cloud mode — nothing in the app can delete your
  remote data.

### Cloud-only capabilities

**Sales** (`post_sale`), **purchases** (`post_purchase`), **expenses**
(`post_expense`) and **settlements** (`post_payment`) are cloud-backed: each one
atomically writes the document, its line items where it has them, a balanced
journal entry and any settlement, and all of them are validated and tenanted
server-side by business membership and role. Expenses are settled at posting
time, so they never produce a settlement row or enter `reconcile()`. **Voiding**
(`void_document`, `void_payment`) is cloud-backed too: it writes exactly one
mirror reversal, links it from the original entry, marks the document VOIDED and
voids any embedded settlement, without ever deleting a row. **Online collection*
(`initiate_gateway_txn` + `settle_gateway_txn`) is cloud-backed since Stage 8 —
see *Collecting online* below. Chart-of-accounts additions, name/description
edits, and archiving are persisted through the accounts table's column-scoped
grants and membership policies. See `src/lib/capabilities.ts` for the single
source of truth.

A settlement always settles a posted sale (money in) or purchase (money out).
`post_payment` locks that document, recomputes what is still outstanding from
the persisted settlement rows — the upfront amount embedded in the original
posting is one of those rows, so it is counted exactly once — and only then
writes one `payments` row and its journal entry (Dr settlement / Cr receivable
for money in, Dr payable / Cr settlement for money out). The direction, the
party snapshot, the status, the reference `RCP-`/`PAY-YYYYMMDD-NNN` and the
journal are all decided by the database: the browser sends a document, an
amount, a method and a date, never a party name, a status or a journal. The
same retry key replays the original payment read-only instead of settling
twice, a changed request under the same key is refused, and a client-supplied
"remaining balance" is never trusted.

Paying a supplier is the same settlement in the other direction, and there is
no second implementation behind it: the **Pay** action on a bill opens that same
form with the bill and the money-out direction already chosen and its
outstanding balance filled in. `post_payment` then writes one `payments` row
(`OUTGOING`, linked to the purchase, `PAY-YYYYMMDD-NNN`) and one journal entry —
**Dr Accounts payable (2010) / Cr settlement account** (1010 cash, 1020 bank,
1040 eSewa, 1050 Khalti, falling back to 1020 when a business has no wallet
account). The same lock, the same recomputed balance, the same over-settlement
refusal and the same idempotency replay apply; the only differences are the
direction, the counterpart account and the reference prefix.

Receiving money on an invoice is the mirror action and, again, the same RPC. The
**Receive payment** action (a hand-with-coins icon, distinct from the gateway's
bolt) appears on a POSTED invoice that still has something outstanding, and
opens the settlement form with that invoice, money IN and its outstanding
balance already filled in — derived from the persisted settlement rows, never
from a stored due column. `post_payment` writes one `payments` row (`INCOMING`,
linked to the sale, `RCP-YYYYMMDD-NNN`) and one journal entry: **Dr settlement
account (1010 cash, 1020 bank, 1040 eSewa, 1050 Khalti, 1020 fallback) / Cr
Accounts receivable (1030)**. Several receipts can be recorded against one
invoice, ending exactly on the total; the upfront receipt embedded in the
original sale is a settlement row like any other and is counted exactly once, so
the invoice derives PAID only when the rows add up. Voiding a receipt with
`void_payment` restores the whole balance, keeps the voided row as history, and
leaves the invoice POSTED — receiving the money again creates a new receipt with
its own reference rather than reviving the old one. The UI disables the action
on a voided or fully received invoice and while a settlement is in flight, and
the browser still cannot write `payments`, `sales` or any journal table.

A sale or purchase still records what was settled at the counter in a
`upfront_paid` column, and it is worth being precise about what that column is:
a **frozen posting-time snapshot of an input**, not a balance. The money is the
`payments` row that `post_sale`/`post_purchase` writes alongside it, linked to
the document and sharing the document's own journal entry. Every balance
decision — `post_payment`, `settle_gateway_txn`, the UI — recomputes from the
rows (`Total − SUM(COMPLETED + POSTED linked settlements) = Outstanding`) and
never reads the column, and the column cannot drift into disagreeing either:
`guard_document_update` makes every column of a posted document immutable to
every role, `service_role` included, so only `status` POSTED → VOIDED can ever
change. Migration 013 writes that rule down where an engineer would look — on
the two columns and on `payments` itself — and
`firebase/tests/database/020_upfront_single_source.test.sql` proves it from
three privilege levels. The column stays because a printed document should show
what the customer settled on the day, and because it is part of the frozen
`post_sale`/`post_purchase` contract; it is simply never consulted for money.

Settlements can be voided (`void_payment`). It locks the settlement, checks
that its journal entry really is its own, writes exactly one mirror reversal
(`REV-<settlement reference>`, dated today) and flips the row to VOIDED. The
sale or purchase it settled stays POSTED and simply shows the money as
outstanding again — `reconcile()` stops counting the voided row, so nothing is
stored or rewritten on the document. Two clicks converge: the second call waits
on the row lock and replays the same committed reversal instead of creating a
second one, and the database's unique index on `reverses_entry_id` makes a
second reversal impossible even for a direct insert. A settlement recorded as
part of its document — the upfront amount on a sale or purchase, which shares
the document's journal entry — cannot be voided on its own; reversing that
entry would reverse the whole sale, so the server refuses it and the list
dims that row, telling you to void the document instead.

### What is still owed — one answer, two views

The same question is answered in two places that must never disagree, and the
rule that keeps them equal is the invariant the settlement workflow is built on:

- the **ledger view** — the net balance of `1030 Accounts receivable` (money in)
or `2010 Accounts payable` (money out), which the dashboard totals and every
statement read;
- the **document view** — for each party,
`SUM(Total − SUM(COMPLETED + POSTED settlements linked to that document))`,
which the invoice list, the register reports and the printed document read.

The comparison is made by the **database**, not the browser.
`public.control_account_integrity()` (migration 014) derives both sides from the
tables — the control account from journal lines, the document side from document
totals minus their valid settlements — and returns the two figures, their
difference and an OK/ERROR verdict per side. `AccountingEngine.checkIntegrity`
reports that verdict as `RECEIVABLE_MISMATCH` / `PAYABLE_MISMATCH` under **Data
health**; it does not compute it, and the test suite fails the build if a
control-account subtraction reappears in the engine.

The function is `SECURITY INVOKER` and takes **no argument**: it returns one row
per business the caller may read and RLS decides which those are. There is no
business id to forge, a non-member gets no rows at all — not zeros, which would
be indistinguishable from a balanced book — and `anon` cannot execute it. It is
`STABLE` and writes nothing: detection is deliberately separate from correction,
so it will name a mismatch but never repair one. If it cannot be consulted the
app says so (`CONTROL_CHECK_UNAVAILABLE`, a warning) rather than showing a clean
bill of health nobody verified.

That matters because this is the one check that must not depend on how much of
the book a client has loaded: two numbers derived from different subsets would
agree by accident. Derived in SQL from the persisted rows, it stays correct when
a read is scoped, filtered or paginated. The client still derives a single
document's own balance (`linkedSettlementTotal` / `outstandingOn`) for the
screens that show one document — that is a per-document read, not a second
version of this invariant.

`firebase/tests/database/024_control_account_integrity.test.sql` pins it: both
sides checked against independently written SQL, the whole workflow walked
(credit, partial, full, refused over-settlement, voided settlement,
re-settlement, refused document void, document void, and the purchase-side
unwind), a mismatch in *either* direction detected, tenant isolation, the
privileges, and a proof that calling it changes no row. 023 walks the same
lifecycle through the RPCs themselves.

`outstandingByParty(docs)` in `src/services/posting.ts` is the only per-party
derivation, and it reads the same `outstandingOn` every other screen does —
skipping voided documents and treating a document settled to exactly its total as
closed. `useBooks` exposes it as `receivableByCustomer` / `payableBySupplier`,
and the dashboard's *Who owes you, and whom you owe* renders those maps through
`outstandingParties` (`src/services/reportData.ts`), which orders by size, shows
at most five, and carries both the total across **every** party and a count of the
ones it is not showing — a balance cannot vanish behind a `slice()`. Nothing is
stored: there is no customer-balance or supplier-balance column to drift, and a
party whose row has not loaded prints as "Unknown party" rather than dropping the
money.

A document's payment state is derived, never stored. `statusFor(total, settled)`
yields UNPAID, PARTIALLY_PAID or PAID, and `reconcile()` re-runs it from the
settlement rows after every mutation, so the two cannot drift. The transitions
that matter, in both directions: UNPAID → PARTIALLY_PAID → PAID as receipts or
supplier payments arrive; PAID → PARTIALLY_PAID → UNPAID when a settlement is
voided, with the document itself staying POSTED and the money received again as a
**new** receipt rather than by reviving the voided one; a VOIDED document owes
nothing and refuses settlement; and a document with settlements standing cannot
be voided until they are reversed — that refusal is the database's own rule, not
a disabled button. No second state machine competes with it.

Over-settlement is refused by the server, not by the form: `post_payment` and
`settle_gateway_txn` lock the document, recompute the balance from the persisted
rows and refuse an amount above it, so no application path can produce a negative
outstanding and two concurrent settlements against one balance cannot both win.

Phase 1 is deliberately **one payment → one document**: each settlement carries
one document, one party snapshot, one journal entry and one reference, which is
what makes the control-account invariant checkable. One payment splitting across
several bills would need a new allocation table plus a rule for partial
allocation and its reversal; that is a real feature, not a refactor, and it is
deferred rather than half-built (see *Known limitations*).

`firebase/tests/database/023_settlement_workflow.test.sql` walks the whole story
through the real RPCs in both directions — a credit invoice, three instalments, a
refused over-settlement, a voided receipt and its reversal, the money received
again, a refused document void while a receipt stands, reversing everything,
voiding the invoice, refusing to settle it; then a bill with an upfront payment,
a partial supplier payment, the balance, and a voided supplier payment — asserting
at every step that the control account and the document rollup still agree. The
client half is pinned in the Stage 15 block of `tests/run.mjs`, including that the
dashboard reads the shared rollup instead of subtracting balances itself.

### The settlement ↔ journal relationship is enforced, not just observed

`control_account_integrity()` answers "do the two views still agree?". Since
migration 016 (`016_settlement_integrity.sql`) the database also refuses to
*store* a settlement whose accounting relationship was never true, so the answer
cannot become "no" by way of an ordinary write:

1. **A settlement names exactly one document.**
   `payments_exactly_one_document` is a table `CHECK`: never both an invoice and a
   bill, never neither. Together with `payments_link_matches_direction` it also
   fixes the direction declaratively — money received settles an invoice, money
   paid settles a bill.
2. **Its journal entry is one of exactly three shapes**
   (`public.assert_settlement_linkage`, a `BEFORE INSERT OR UPDATE` guard on
   `payments`): the settlement's **own** `PAYMENT` entry (`post_payment` /
   `post_settlement_core`), the linked **invoice's** `SALE` entry (the upfront
   settlement `post_sale` writes with the document's own entry), or the linked
   **bill's** `PURCHASE` entry (`post_purchase`). A settlement hung off another
   settlement's entry, off a different document's entry, or off a `MANUAL` or
   `REVERSAL` entry is refused, at `INSERT` and at `UPDATE`.
3. **A `VOIDED` settlement carries the reversal of that entry.** Both void paths
   already write the mirror and link it *before* flipping `doc_status`, so a
   legitimate void passes while "voided but never reversed" — cash still standing
   in the ledger against a settlement that stopped counting — cannot be stored.
4. **A reversal reverses a first-hand event** (`assert_reversal_shape`, a
   `BEFORE INSERT` guard on `journal_entries`): the entry it names must exist in
   the same business, must not itself be a reversal (so a void terminates), and
   the reversal must carry the same source identity. Duplicate reversals were
   already impossible (`journal_entries_reverses_uidx`), as were two settlements
   sharing one entry (`unique (journal_entry_id)`) and the re-pointing or
   mutation of a posted row (`payments_guard_update`).

Tenancy is not re-checked here: the composite foreign keys
(`(business_id, linked_sale_id)`, `(business_id, linked_purchase_id)`,
`(business_id, journal_entry_id)`) already make a cross-tenant relationship
unrepresentable. The guards are closed to client roles, and they only ever
classify a relationship — they contain no arithmetic over settlement amounts and
no document total, so there is still exactly one definition of what is
outstanding.

Why the RPCs were not enough on their own: they are the only write path a client
has, and `post_payment` still takes the document row `FOR UPDATE` before
recomputing the balance, which is what serialises concurrent settlements (the
race in `027_settlement_integrity_concurrency.test.sql` still shows the loser
blocking on that lock and then being refused as over-settlement). What the RPC
boundary cannot do is stop the *next* writer — a future RPC, an import, a support
script, a mistake — from storing a shape it does not know about. Relational shape
belongs to the schema, so that is where these three rules live: one `CHECK`, and
two guards that are each a single primary-key lookup, never write, and never
repair anything.

Detection is still the detector's job. `control_account_integrity()` (migration
014) continues to report divergence — historical rows, hand-built rows, anything a
future migration has not anticipated — and a book that was already inconsistent is
reported, not rewritten. The evidence ships with the schema:
`026_settlement_integrity.test.sql` (74 assertions) walks every valid path
(sale, purchase, partial, full, void, re-settlement, the embedded upfront
settlement counted once, the gateway settlement) with a whole-book invariant
query returning zero violations after each step, then refuses every mis-linked
shape one by one — no document, two documents, another settlement's entry, a
different document's entry, a `MANUAL` entry, a `REVERSAL` entry, a `VOIDED`
settlement without its reversal, a missing entry, relinking, amount mutation,
un-voiding, deletion, a duplicate reversal, a reversal of a reversal, a drifted
reversal — and checks tenant isolation, privileges and the invariant afterwards.
`027_settlement_integrity_concurrency.test.sql` is the one genuine two-session
race. The app side is pinned too: no source file writes `payments`,
`journal_entries` or `journal_lines` directly, state is only ever applied *after*
an RPC resolves, and a refusal is mapped to a sentence instead of a constraint
name while an unrecognised error is still surfaced unchanged.

### Collecting online (eSewa / Khalti)

Online money is a two-step, server-authoritative flow, and the two steps are
deliberately kept apart:

1. **`initiate_gateway_txn`** (migration 011) records a *collection* against a
   POSTED invoice: provider, gateway reference, amount, business and
   `auth.uid()` as the initiator. It locks the invoice, recomputes the
   outstanding balance from the persisted settlements and refuses an amount
   above it. A collection is a provider interaction, **not** an accounting
   event — nothing is posted here.
2. **`settle_gateway_txn`** (migration 012) is the only bridge to the books. The
   browser hands it the *server's* normalised answer — our API server asked the
   gateway directly — and it re-validates every field against the persisted row
   (provider, reference, amount, currency, ownership) before locking,
   recomputing and posting exactly one settlement through the same accounting
   core `post_payment` uses: Dr eSewa/Khalti clearing, Cr receivable, a `PAYMENT`
   journal entry and an `RCP-YYYYMMDD-NNN` reference. The new payment carries
   `gateway_transaction_id`; the collection records its `payment_id` and
   `verified_at`. Either both rows exist or neither does.

Lifecycle: `gateway_transactions.status` holds the provider's own state
(INITIATED / PENDING / COMPLETED / FAILED / EXPIRED / REFUNDED / CANCELED).
`COMPLETED` means the *gateway* confirmed the money moved — it does not mean
anything reached the books. Settlement state is derived, never stored twice:
`public.gateway_settlement_state(payment_id)` answers UNSETTLED, SETTLED or
VOIDED from the linkage columns. A retry replays the committed settlement
read-only, a second click waits on the row lock and converges on the same
result, one collection can never produce two payments, and a settlement that was
later voided is reported as voided rather than revived.

The browser cannot mark a collection verified or settled: `authenticated` holds
no INSERT/UPDATE on `gateway_transactions` or `payments`, a trigger refuses an
update that claims COMPLETED without a recorded server-side verification, and
the redirect back from the gateway is only a prompt to ask the server again
(also available at any time under **Data health → Re-check**). Provider quirks
live behind one boundary — `server/verification.js` maps eSewa's and Khalti's
statuses onto the seven schema statuses and produces a single shape, failing
closed on anything unrecognised — so the database sees one shape from both
providers and no merchant secret ever enters the bundle.

Purchase and expense numbering is allocated by the database as
`PO-YYYYMMDD-NNN` and `EXP-YYYYMMDD-NNN` under a per-business lock, so two
devices posting at the same moment cannot issue the same reference. A
client-supplied reference is still accepted and honoured.

Voiding mirrors the original journal exactly — every debit becomes a credit on
the same accounts, with the same snapshots — under a `REV-<original reference>`
entry dated today in the business timezone, and a document can only be reversed
once. A purchase or sale whose upfront settlement is part of its own journal
entry is reversed once, as one accounting event; a settlement that has its own
journal entry blocks the void until it is voided on its own, after which the
document can be voided too.

### Signing in

Sign up or sign in with email and password. "Forgot password?" emails a
reset link, and if email confirmation is enabled you can resend the
confirmation email from the sign-in screen.

The screen carries the product mark, one full-width primary action, a reveal
toggle inside the password field and `autocomplete` hints for password managers.
It is built from the product's own neutral palette: `tests/run.mjs` fails the
build if any other hue appears in `AuthModal.tsx`, so a future restyle cannot
quietly introduce one, and it also pins that the screen still leaves through
`authService` rather than reaching a database client of its own.

Sessions belong to a device, so the same account can be open on a PC and a phone
at once. **Settings → Account** always shows who is signed in and offers two
ways out:

- **Sign out** ends the session on this device only (`scope: 'local'`). Your
  phone stays signed in. This is deliberately not the library default, which is
  `global` — an ordinary sign-out would otherwise revoke the phone's refresh
  token without anyone asking for that.
- **Sign out everywhere** asks for `scope: 'global'` behind a confirmation,
  because it ends the session on every device including the phone.

Signing out clears the whole authenticated application state: the profile, the
membership, the loaded books and any open draft. The app only shows the sign-in
screen once the client confirms its stored session is gone (`getSession()`
returns nothing); if the session survived, the failure is reported instead of
pretending the logout worked. The server-side revoke is best-effort and is
retried locally, so a dropped connection still signs this device out — and the
person is told when the remote revoke did not happen. Nothing else in the
browser persists a session: `localStorage` is never the source of truth for
accounting data, so a reload after signing out cannot restore a session.

A book load that is still in flight when the session ends is discarded rather
than applied, so the previous account's rows can never reappear behind the
sign-in screen — every load carries the session epoch it started in and is
dropped once that epoch moves.

## Security model and access control

The database is the boundary. The UI only reflects it.

- **Roles.** Membership of a business is `OWNER`, `ACCOUNTANT` or `VIEWER`
  (`business_members.role`). OWNER manages membership and settings; OWNER and
  ACCOUNTANT may post, void and settle; a VIEWER may read everything in that
  business and write nothing. The check lives inside each RPC, so hiding a button
  is never the control.
- **Tenancy.** Every financial row carries `business_id`, and every RLS policy
  resolves membership for `auth.uid()`. An anonymous caller reads nothing.
- **Writes.** `authenticated` holds **no** `INSERT`, `UPDATE` or `DELETE` privilege
  on any financial table (`sales`, `sale_items`, `purchases`, `purchase_items`,
  `expenses`, `payments`, `journal_entries`, `journal_lines`,
  `gateway_transactions`). Money only moves through the nine SECURITY DEFINER
  RPCs, each with `search_path = ''`, `EXECUTE` revoked from `public`/`anon` and
granted to `authenticated` alone; the internal helpers (`post_settlement_core`,
  `gateway_settlement_state`) are not callable by a client at all. The one
  client-writable surface is the chart of accounts, which is column-scoped.
- **Browser.** `src/lib/firebase.ts` uses the publishable key only; the
  service-role key never appears in `src/`, and the client cannot be built without
  passing the environment guard.
- **Credentials in errors.** `server/redact.js` masks credential-shaped text
  before the payment API logs a provider failure or returns it, so a useful
  business error ("insufficient balance") survives while the signature and the key
  do not. A provider's own answer is never the accounting truth: only
  `settle_gateway_txn` writes money.
- **Audit trail.** POST, VOID and SETTLE record actor and time (`created_by`,
  `posted_by`, `voided_by`, `created_at`, `posted_at`, `voided_at`) and a void
  links its mirror reversal to the entry it reversed (`reversal_of`). Who, when,
  what effect and what was undone are all recoverable, and the void keeps both
  rows rather than deleting history. There is deliberately no separate audit
  table: the ledger is the record.

The database side is pinned by
`firebase/tests/database/001_rls_tenancy.test.sql` and
`022_security_boundaries.test.sql` (48 assertions: the grants on every financial
table for every role, `search_path` on each definer, the helpers that must not be
callable, VIEWER refusals, cross-tenant refusals, and the audit trail). The client
side is pinned in the Stage 13 block of `tests/run.mjs`: no direct writes to
financial tables, account writes limited to the column-scoped accounts policy,
an allowlist of the nine accounting RPCs, and the bundle scan above.

### Payment API security model

The small Express server (`server/index.js`) holds eSewa's HMAC secret and
Khalti's key. Payment and session routes authenticate the caller
(`server/auth.js`); contact and service-status routes are public and rate
limited. Routes that spend a merchant credential authorize the business the
request names.

| Route | Who may call it |
|---|---|
| `GET /api/payments/config` | any signed-in user with a verified email — provider availability, no secret |
| `POST /api/payments/esewa/initiate` | signed-in **OWNER/ACCOUNTANT** of the invoice's business |
| `POST /api/payments/esewa/verify` | signed-in **OWNER/ACCOUNTANT** of the business owning that collection |
| `POST /api/payments/khalti/initiate` | signed-in **OWNER/ACCOUNTANT** of the invoice's business |
| `POST /api/payments/khalti/lookup` | signed-in **OWNER/ACCOUNTANT** of the business owning that collection |

**How a request is authenticated.** The browser sends
`Authorization: Bearer <Firebase ID token>`; Firebase Admin verifies it with
`verifyIdToken` and requires a verified email. The email identifies the
Supabase Auth user, while business and role come from the database. No identity
or role supplied in the request body is trusted.

**How it is authorized.** The server uses its Supabase admin client to read the
invoice or collection, maps the verified Firebase email to a Supabase profile,
confirms that profile's ID and email against Supabase Auth, then checks the
`business_memberships` role. Another tenant's record returns 404; a VIEWER
member receives 403. The admin client bypasses RLS, so this explicit check is
required for every payment route before contacting a provider.

**Failure semantics.** 401 unauthenticated (no detail, and never the token),
403 authenticated but not permitted, 400 malformed request, 404 not found or not
disclosed, 409 a void document, 422 an amount above the invoice, 5xx ours or the
provider's. Provider errors pass through `server/redact.js` before they are
logged or returned.

**Availability is declared.** A built browser app only calls these routes when
`VITE_PAYMENT_API_URL` names the API's origin (development uses the Vite proxy
to the local API process). Configure the function credentials and gateway keys
at that origin before enabling online collection.

**What this boundary is not.** It is not the financial write path. It gates who
may *ask*; `public.initiate_gateway_txn` and `public.settle_gateway_txn` still
re-derive membership, the invoice, the outstanding balance and the provider
identity from the database. Neither the browser nor this server can post money by
asserting that a payment succeeded.

**Payment API authentication is separate from provider webhook
authentication.** Webhooks are deferred, and they are a different mechanism:
eSewa and Khalti will call them with no user session, so they will live on their
own mount and be verified by a signature over the raw body — not by the bearer
token described here. Nothing in this boundary has to be undone to add them.

`tests/payment-api.live.mjs` exercises all of this against the local stack (real
sessions, real memberships, real RLS): anonymous and invalid tokens on every
route, a non-member 404, a VIEWER 403 on all four merchant routes, an owner's
signed eSewa payload, an amount above the invoice, and a reference that only
appears inside the returned blob. The offline suite pins the decisions, the
failure shapes and the structure; the live script proves the wiring.

## Reports and printed documents

Every statement and every printable record is one A4 sheet with one design
language. The sheet is a real 210mm x 297mm page on screen (`.report-sheet` in
`src/index.css`) and becomes the whole print job through `@page { size: A4
portrait; margin: 16mm 14mm 18mm }`; table headers repeat on every page, totals
and empty states are kept whole, and a second sheet in one job starts a new
page. `src/components/ReportShell.tsx` holds the pieces — header, section, ruled
statement row, table, empty state, footer — so nine reports cannot drift into
nine designs. Printing a single document from its overlay sets
`body[data-print-sheet=open]`, which drops the app behind it, so the sheet is
what prints.

Nine reports: Profit & loss, Balance sheet, Trial balance, **Sales**, **Purchases**,
**Expenses**, General ledger, Cash & bank movement and the VAT summary. The
statements come from `AccountingEngine` exactly as before — the report layer adds
no financial logic of its own. The three document registers are shaped by
`src/services/reportData.ts`, which sums settlements through the same
`linkedSettlementTotal` the server uses, so a report and an invoice can never
disagree about what is outstanding. Each register offers the filter that fits it
(customer, supplier, category, account), the period picker is shared with the
dashboard, and the printed sheet states the period, the source and the filter
that produced it — a figure never appears without the context that explains it.

There is no demo data anywhere in this layer. An empty period prints the business,
the report title, the period and "No financial transactions have been recorded
for this period." — never a placeholder figure, a sample row or a synthetic chart.
Voided documents and voided settlements are excluded from the registers and the
sheet says how many were left out, because a void is already in the ledger as its
own reversal. A ledger longer than 400 lines says so on the sheet and hands the
full set to the CSV export rather than laying out a hundred pages.

Any sale, purchase, expense or settlement can be opened as a printable document
(`src/components/DocumentPrintView.tsx`, the document icon on each row). A sale
invoice prints the business and party details that actually exist, its line items,
its totals and its settlement history; a receipt prints the payment details, the
document it settled and the journal lines that were posted for it; an expense
voucher prints its category, method and entry. The viewer only reads — it holds no
RPC and no mutator, so opening a document cannot change financial state.

A printed document shows two figures that are deliberately kept apart. The live
balance is `Total − SUM(COMPLETED + POSTED settlement rows)`, summed from the
`payments` rows on every render. The posting-time snapshot —
`sales.upfront_paid` / `purchases.upfront_paid`, frozen by the database and
carried by the adapters as `postingSnapshot`, never as `paidAmount` — is printed
beneath it, labelled "Settled when this document was posted (historical record)",
so a reprint reproduces what the original said. It is never added to a paid total
or subtracted from a balance: `tests/run.mjs` fails the build if the snapshot and
a balance ever appear in the same arithmetic expression. `DocumentPrintView` also
carries the expense voucher kind, because an expense is a business record like any
other even though the brief listed only sales, purchases and receipts.

The document system prints one currency label, `NPR`, whatever the on-screen
symbol toggle says: paper goes to a bank, an auditor or the IRD, and an ISO code
is unambiguous on all three. Dates follow the BS/AD toggle the rest of the app
uses, and a document header shows both calendars so a filed copy can be matched to
either register. Page numbers are not invented: no browser counts printed pages
from CSS, so the sheet's footer carries the real generation date and the
stylesheet declares `@page` margin boxes that a paged-media engine (Prince,
WeasyPrint) renders as "Page X of Y".

`firebase/tests/database/021_report_read_path.test.sql` pins the data side of all
this: the read path is tenant-scoped (a report cannot be built from another
business's rows, and anon holds no read privilege at all), the register's balance
is the row sum with voided settlements excluded, every posted entry balances, and
the snapshot stays frozen while the live balance moves. The presentation side —
the sheet geometry, the empty state, the snapshot rule, the print CSS and the
read-only viewer — is pinned in the Stage 12 block of `tests/run.mjs`.

### Aged receivables and payables

**Reports → Aged balances** answers one question: how much is still owed, by whom,
and how overdue is it. It works on both sides — receivables from posted invoices,
payables from posted bills — and shows both at once unless it is narrowed to a
single customer or supplier.

Aging is a **classification** of the live outstanding balance, never a second
definition of it. A row is aged only for what is still owed on it (a 100,000
invoice with 40,000 received ages 60,000, once, in one bucket), documents settled
to zero are dropped rather than printed as zero rows, voided documents never
appear, and a voided or unconfirmed settlement stops counting the moment it stops
being money — so the balance returns to the bucket the document's due date gives
it. The posting-time snapshot on the document is not read: it is history, not money.

Buckets are `Not due`, `1–30`, `31–60`, `61–90` and `90+`, counted in whole days
past **the due date recorded with the document** (see below) using **one explicit
as-of date** (defaulting to the end of the selected period, movable on the
report). A document due today is not overdue; the boundary cases — 0/1, 30/31,
60/61 and 90/91 days — are asserted individually. The day count is UTC day
arithmetic, so no timezone or daylight-saving boundary can move a figure, and the
same books always produce the same report.

### Payment terms and due dates

A due date is **metadata about when an amount is expected**, not an amount. It is
the only thing the terms change: no journal line, settlement row, document total,
posting snapshot or control-account balance depends on it, and the Stage 18
block of `tests/run.mjs` plus suite `025_credit_terms.test.sql` assert that the
same request posted with 0, 7, 30 and 90 day terms produces identical money and
only a different date.

- **The terms are the input; the due date is derived.** A sale or purchase form
  has one control — `Payment terms` (`Due immediately`, `Net 7/15/30/45/60/90`, or
  `Other…` for any number of days) shown whenever something is left owing — and it
  previews the due date underneath. The browser sends **only whole days**
  (`p_payment_terms_days`); it never sends a date, so the date the form showed and
  the date the books hold cannot disagree.
- **The database computes and holds it.** `post_sale` / `post_purchase` write
  `payment_terms_days` and `due_date = date + payment_terms_days` inside the
  posting transaction (migration 015), and a table constraint
  (`sales_due_date_matches_terms`, `purchases_due_date_matches_terms`) refuses a
  row whose due date disagrees with its terms. There is exactly one authoritative
  answer to "when is this document due?" and one way in.
- **It is immutable, like the rest of a posted document.** `guard_document_update`
  already forbids every column but `status` from changing after posting, so a
  settlement, a void or a re-settlement can never move a due date. (This is also
  why `due_date` is a stored column guarded by a `CHECK` rather than a `GENERATED`
  one: PostgreSQL shows a stored generated column as `NULL` inside that trigger's
  `NEW`, which would have made every void look like an edit to a posted document.)
- **A document settled in full at posting records 0 terms.** A cash sale has no
  credit period, so the form hides the control and sends `0`.
- **Aging reads it and nothing else.** `dueDateOn()` in `src/services/reportData.ts`
  returns the persisted `due_date`; there is no fallback to the document date. The
  schedule prints the document date, the due date and the terms side by side, and
  a reprinted invoice states `Invoice date`, `Due date` and `Payment terms` as
  separate facts.
- **What a reprint says for an old document:** documents posted before migration
  015 record `0` terms with `due_date = date`. That is how they were aged before
  this feature existed, so no figure moved and no contractual terms were invented
  for a document written by a system that could not record them. The report note
  says so on the sheet.
- Changing the terms can never alter the money, and the control-account check
  (`control_account_integrity()`) is unchanged: AR and AP control balances agree
  with document-side outstanding whatever terms the documents carry.

Aging lives in the reporting layer (`receivablesAging` / `payablesAging` →
`agingView`) over the same rows and the same `linkedSettlementTotal` the registers
use, and it introduces no stored balance, no cached total and no new formula. The
database-derived invariant stays where migration 014 put it: `control_account_integrity()`
is what proves `ledger control balance = document-side live outstanding`. Aging
total must equal the register's outstanding figure, and the Stage 17 block of
`tests/run.mjs` asserts exactly that — if the two ever disagree, the schedule is
wrong, not the ledger.

The upstream edge is stated rather than hidden: like the registers, aging is
computed in the browser from the rows the loader has scoped to the member's
business. It stays correct as the book grows, but a future read path that pages
the registers must move this layer with them (a SQL aging view) rather than
aging a partial book.

## Known limitations and deferred work

Known limitations, stated plainly:

- `sales.upfront_paid` / `purchases.upfront_paid` are **posting-time snapshots**
  kept so a document can be reprinted as it was issued (migration 013). They never
  contribute to a balance: outstanding is
  `Total − SUM(COMPLETED + POSTED settlement rows)`. The UI receives them only as
  `postingSnapshot`, never as a paid amount, and a test fails if the two are ever
  added together.
- **A settlement's link to its document and journal entry is prevented; the
  *amount* side is still detected.** Since migration 016 a settlement cannot be
  stored with no document, two documents, or a journal entry that is not its own
  event (including a `VOIDED` one without its reversal, and a reversal of a
  reversal). What remains detection is everything a single row cannot witness:
  a ledger entry that never had a document behind it, an amount that no longer
  matches the ledger's AR/AP movement, or a historical row written before the
  guard existed. Those are exactly what `control_account_integrity()` reports
  under Data health — and it reports them rather than repairing them.
- **A posted settlement whose entry is reversed remains representable for the
  moment between the reversal and the `VOIDED` flag.** Every legitimate void does
  precisely that inside one transaction, so the rule is enforced on the
  committed state (`VOIDED` ⇒ reversed) rather than mid-transaction; the other
  direction is refused by `void_payment`, which fails closed on a `POSTED`
  settlement whose entry already carries a reversal.
- **A business, customer or supplier has no default terms.** Terms are chosen per
  document on the posting form. A default that silently applied to every new
  invoice would be a policy the books cannot show, so it was left out rather than
  guessed at; the column default of `0` means "due immediately" and nothing else.
- **Documents posted before migration 015 have no real terms.** They record `0`
  days and fall due on their own date — the meaning they already had. Their due
  dates are therefore not contractual, and the aging sheet says so; there is no
  way to recover terms nobody ever entered.
- **Multi-invoice supplier allocation is not implemented.** One payment settles
  one document in both directions: `payments` carries a single `linked_sale_id` or
  `linked_purchase_id`, one party snapshot and one journal entry, which is what
  makes the receivable/payable control account checkable against the document
  rollup. Paying NPR 10,000 against two bills of NPR 5,000 and NPR 7,000 today
  means two payments, each with its own reference and reversal — correct, just
  more typing. A one-payment-many-documents model needs a split table, a rule for
  what a partial allocation means, and a reversal rule for each split; that is a
  product decision with its own schema, deliberately deferred rather than guessed
  at.
- **Online collection is incoming only.** eSewa and Khalti have no supplier
  disbursement API this app can rely on, so purchases are settled by manual
  accounting entry, not by a gateway. The money-out path is otherwise symmetric:
  the same `post_payment`, the same lock and recomputed balance, the same
  over-settlement refusal, the same idempotency replay, the same void and
  reversal.
- Report page numbers depend on the print engine. The stylesheet declares `@page`
  margin boxes, which a paged-media engine prints as "Page X of Y"; Chrome
  supplies its own footer instead.
- `npm run build` emits a single ~1 MB chunk. The report/document layer is the
  obvious candidate for code-splitting; it is a known cost, not an oversight.
- The guard makes a dangerous target loud rather than impossible: a developer who
  sets `VITE_ALLOW_REMOTE_IN_DEV="yes"` can still run a development build against
  a remote project on purpose.
- **Provider webhooks are not implemented.** Payment routes authenticate every
  caller and initiation checks the invoice against the caller's verified email
  and business membership. A provider callback arrives with no
  user session at all, so it needs a different mechanism: a separate mount, a
  signature verified over the raw request body, and no bearer token. Until that
  exists there is no public route on this server.
- **Rate limiting uses shared Firestore counters** for the API and OTP callables,
  so Vercel instances use the same limits. Deploy `firestore.indexes.json` with
  `firebase deploy --only firestore:indexes` to enable TTL cleanup for the
  short-lived limiter documents.
- A non-`VITE_` secret in `.env.local` (for example a deployment token) is not
  bundled, but nothing stops it being added there; the test suite only proves it is
  not in the bundle.

Deferred — not started and not half-built: multi-invoice supplier allocation,
gateway collection against purchases, refunds, chargebacks, payouts, bank API
integrations, gateway webhooks, an advanced reconciliation dashboard, aged
receivables/payables, attachments, realtime, server-side PDF, batch printing,
inventory, payroll, MFA, session timeouts, subscriptions, and AI bookkeeping.

## Project layout

```
src/
  lib/            pure helpers: BS/AD dates, money/VAT math, ids, CSV export, session exit policy,
                  envGuard (which project this build may talk to), routes (path → screen),
                  preferences (device display setting), paymentApi (is there an API to call?)
  services/       accounting engine, posting rules, report shaping, storage, payment client
  state/          useBooks — all app state and the actions that mutate it
  components/     views, the shared UI kit, and the A4 report/document layer
  data/           the default chart of accounts and an empty business profile
server/           Express API: eSewa and Khalti integration, plus redact.js (credential masking)
tests/            offline test runner (node tests/run.mjs / npm test)
```

