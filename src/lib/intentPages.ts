/**
 * The intent pages — one page per thing a business searches for.
 *
 * The public site describes the product (landing, pricing, about, contact) and
 * the terms it is offered under (privacy, terms). What it did not describe was
 * the *reason* somebody goes looking: a paswal wondering about a hallbook that
 * adds up, an agency chasing unpaid invoices, a business that wants its dates
 * written in Bikram Sambat, a shopkeeper with a VAT return due. Each of those is
 * a different question, so each gets a page of its own that answers it.
 *
 * Two rules the copy is written under, both of them about not saying something
 * the product cannot support:
 *
 *  - Every feature named here exists in the app and is reachable on the plan
 *    this file says it is. `FEATURE_FOR_ROLE` in `lib/roles.ts` decides that,
 *    not the marketing copy.
 *  - Every page states what the app does *not* do for that reader. An agency
 *    page that hides the absence of job costing gets a refund conversation; the
 *    same page that says it out front gets a customer who knew.
 *
 * This module is the single source of truth for the SPA (the router, the page
 * component and `lib/pageMetadata.ts` all read it). `scripts/prerender.mjs`
 * holds its own copy of the title, description, breadcrumb label and fallback
 * snippet because Node cannot import TypeScript — the drift test in
 * `tests/run.mjs` compares the two, the same way the rest of the public
 * metadata is guarded.
 */

export interface IntentSection {
  heading: string;
  /** Prose paragraphs, in reading order. */
  paragraphs: string[];
  /** Optional list under the paragraphs — used for "what you get" enumerations. */
  bullets?: string[];
}

export interface IntentFaq {
  q: string;
  a: string;
}

export interface IntentPage {
  /** Public path, and the canonical URL's tail. */
  path: string;
  /** The static document's file name in `dist`, so it must be URL-safe. */
  slug: string;
  /** Short enough for a breadcrumb; the `h1` is too long for one. */
  crumb: string;
  /** Label in the footer's Guides column. */
  navLabel: string;
  /** Document `<title>`. */
  title: string;
  /** Meta description, and the `og:description` mirror. */
  description: string;
  eyebrow: string;
  h1: string;
  lead: string;
  sections: IntentSection[];
  notForHeading: string;
  notFor: string[];
  faqs: IntentFaq[];
}

export const INTENT_PAGES: IntentPage[] = [
  {
    path: '/hallbook-software',
    slug: 'hallbook-software',
    crumb: 'Hallbook',
    navLabel: 'Hallbook for shops',
    title: 'Hallbook Software for Kirana Pasals in Nepal — Zeyks Book',
    description:
      'A digital hallbook for Nepali shops: daily sales, customer udhar with due dates, supplier bills and expenses in NPR, with Bikram Sambat dates and printable A4 statements. From NPR 299 per month.',
    eyebrow: 'For shops and pasals',
    h1: 'Hallbook software for kirana pasals',
    lead: 'A hallbook is the diary a shop keeps by hand: what sold today, what a regular took on credit, what the supplier delivered, what the shop spent. Zeyks Book keeps those four things in one book that adds up — in NPR, on the dates you actually work, without a calculator at the end of the month.',
    sections: [
      {
        heading: 'The four pages of a paper hallbook',
        paragraphs: [
          'Most pasals already keep a hallbook, and it works right up to the point you need a total. A month of sales becomes an evening with a calculator, and "who owes me what" becomes a search through three notebooks.',
        ],
        bullets: [
          'Sales — an invoice for the items or the amount, the customer, the date and the terms. A cash sale settles as you enter it; a credit sale stays open until the money is recorded.',
          'Purchases — supplier bills with the bill number, the amount and the due date, so what arrived and what you owe sit in the same place.',
          'Expenses — rent, electricity, transport and wages under your own expense heads in the chart of accounts, instead of a second notebook.',
          'Parties — every customer and supplier carries a running balance, so the udhar list is a number you read rather than pages you add up.',
        ],
      },
      {
        heading: 'Credit sales, without the mental arithmetic',
        paragraphs: [
          'Udhar is the hardest part of a hand-written book to keep honest, because the balance is whatever the last person who wrote in it believed. In Zeyks Book a credit sale is an open item with a due date. When the customer brings money in, you record the settlement against their account, and the remainder is what they still owe.',
          'The aged receivables and payables report sorts everything still open into time bands, so a two-month-old udhar does not hide behind this week\u2019s small sales. That report is on the Premium plan; the party balance itself is on both.',
        ],
      },
      {
        heading: 'NPR, Nepali dates, and a PAN that prints',
        paragraphs: [
          'Amounts are in rupees, with paisa carried to two decimals and rounded the way accounts are rounded. Dates can be written in the Bikram Sambat calendar, and the Gregorian date is kept beside them. Your PAN and your customer\u2019s print on the documents, and the statements fit A4 paper — which is what an accountant asks you to hand over.',
        ],
      },
      {
        heading: 'Stock, when you get to it',
        paragraphs: [
          'A hallbook knows what was sold but rarely what is left. On Premium, items carry a purchase price, a selling price and a stock quantity, adjustments are recorded as their own entries rather than as a re-count, and the inventory report values what is sitting on the shelf.',
        ],
      },
      {
        heading: 'What a shop pays',
        paragraphs: [
          'Plus is NPR 299 per month and covers the daily hallbook work: the dashboard, sales, purchases, expenses and your business settings. Premium is NPR 499 and adds settlements, the report set — profit and loss, balance sheet, trial balance, aged receivables and payables, VAT summary — inventory, and the data health checks. Nothing is charged per person.',
        ],
      },
    ],
    notForHeading: 'Where a shop hits the edge',
    notFor: [
      'No till screen and no barcode checkout. Zeyks Book records what was sold; it does not ring a customer up at the counter.',
      'No payment collection. A customer pays in cash, by bank transfer or by wallet, and you record the settlement.',
      'No payroll. Wages go in as an expense.',
      'One set of books per account. A shop with several locations keeps them as separate accounts, not one combined book.',
      'You can download a JSON snapshot of your books from Settings, but restoring one is not available yet.',
    ],
    faqs: [
      {
        q: 'Is a hallbook the same thing as an accounting ledger?',
        a: 'It is the hand-written version of the same record: daily sales, credit given to customers, purchases from suppliers, shop expenses. Zeyks Book keeps those as posted entries, so the totals, the party balances and the reports all come out of the numbers you wrote down rather than a second set of figures.',
      },
      {
        q: 'Can I track customer udhar (credit) in Zeyks Book?',
        a: 'Yes. Enter the sale as a credit sale with a due date and it stays open. Record a payment against that customer when money comes in, and the balance shows what remains owed. The aged receivables report groups what is still outstanding into time bands on the Premium plan.',
      },
      {
        q: 'Do I need an accountant to start?',
        a: 'No. The interactive demo walks through sample books, and a new account opens with a chart of accounts already seeded for a Nepali trading business. Most shops only need their own expense heads, their regular customers and their suppliers before the first entry.',
      },
      {
        q: 'What happens to my old paper hallbook?',
        a: 'You keep it. Most shops start Zeyks Book from the current date rather than re-typing years of pages. Past balances can be entered — an opening stock figure, what each customer owed on the day you switched — but there is no migration service and no way to read the old book in.',
      },
      {
        q: 'Does it work on a phone, and without internet?',
        a: 'It runs in the browser on a phone or a computer, and the layout adapts to a small screen. Saving needs a connection. Without one, the app shows the last books it had saved on that device, read-only, until you are back online.',
      },
    ],
  },
  {
    path: '/agency-accounting',
    slug: 'agency-accounting',
    crumb: 'Agencies',
    navLabel: 'Agencies & freelancers',
    title: 'Accounting Software for Agencies and Freelancers in Nepal — Zeyks Book',
    description:
      'Service businesses bill clients in NPR with PAN and due dates, record expenses under their own heads, and see profit, unpaid invoices and VAT on printable A4 reports. For agencies, studios and freelancers in Nepal.',
    eyebrow: 'For agencies and freelancers',
    h1: 'Accounting for agencies, studios and freelancers',
    lead: 'A service business has no godown and not many items — but it still has to answer the same three questions: who has not paid, what did the month cost, and is this in profit. Zeyks Book answers those for a digital agency, a design studio, a consultancy or a freelancer billing Nepali clients, in NPR, with your PAN on the invoice.',
    sections: [
      {
        heading: 'What an agency\u2019s books actually consist of',
        paragraphs: [
          'Strip away the software categories and an agency has four streams, not forty.',
        ],
        bullets: [
          'Invoices to clients — retainers, project milestones, one-off jobs.',
          'Expenses — software subscriptions, hosting, equipment, transport, rent, contractor fees.',
          'Money in — bank transfers, wallets, cash, recorded against the invoices they settle.',
          'The questions an accountant asks — profit and loss, what is owed to you, what you owe.',
        ],
      },
      {
        heading: 'Billing clients',
        paragraphs: [
          'A sales invoice takes the client, the work line by line at a quantity and a rate or as one amount, any discount, and VAT when the business is registered. It carries your PAN and the client\u2019s, a date you can write in BS or AD, and a due date when the work is not paid on delivery.',
          'A posted invoice is corrected by voiding it and issuing the right one, which leaves both on the record. Nothing silently changes a number a client has already been billed for.',
        ],
      },
      {
        heading: 'Expenses under their own heads',
        paragraphs: [
          'Every expense posts against an expense account in the chart of accounts, so subscriptions, hosting and rent are separate lines in the profit and loss instead of one miscellaneous figure. Heads can be added, renamed or retired as the business changes, and the expense report filters by them.',
        ],
      },
      {
        heading: 'Getting paid, and chasing what is not',
        paragraphs: [
          'Settlements are recorded against the open invoices they pay off, so a client who pays half of one and all of another leaves an accurate remaining balance rather than a note in a comment field. What is still open, and how overdue it is, comes out in aged receivables. That is a Premium feature, along with the rest of the report set.',
        ],
      },
      {
        heading: 'What the month looked like',
        paragraphs: [
          'Profit and loss, trial balance, balance sheet, a general ledger for any single account, and the sales, purchase and expense registers. All of them print on A4 with the business, the PAN and the period in the header, and all of them read posted entries — so the number you hand your accountant is the number the ledger holds.',
        ],
      },
    ],
    notForHeading: 'Read this before you subscribe',
    notFor: [
      'No project or job costing. The books are one ledger for the business; there is no per-client, per-campaign or per-project profit line. An agency that prices by project profitability needs a different tool.',
      'No time tracking and no billable-hours capture. Hours are your business, not the software\u2019s.',
      'No payroll. Salary and contractor costs are entered as expenses.',
      'No payment collection — no gateway, no payment link, no bank feed. You record the money when it arrives.',
      'No recurring invoice scheduling. A monthly retainer is issued again by hand.',
      'Reports and settlements need the Premium plan (NPR 499 per month). Plus (NPR 299) covers invoicing, expenses and settings.',
    ],
    faqs: [
      {
        q: 'Is this sized for a two-person agency?',
        a: 'Yes. Small is the target: one account, one set of books, and pricing per business rather than per seat. Nothing scales down to a price that only makes sense for a large firm.',
      },
      {
        q: 'Can I show VAT on a service invoice?',
        a: 'When the business is marked VAT-registered in Settings, tax lines post automatically. The rate defaults to 13% and is editable, and a line can be entered as VAT-inclusive or VAT-exclusive. The VAT summary reads what was posted, not what the invoice says.',
      },
      {
        q: 'Do you handle retainers and monthly billing?',
        a: 'You issue each month\u2019s invoice yourself. There is no recurring-invoice scheduler, so a retainer stays a habit rather than an automation.',
      },
      {
        q: 'Can I see profit per client or per project?',
        a: 'Not today. There is no project or job dimension on a journal line, so profit is reported for the business as a whole. You can filter the sales register by party to see what one client was billed and what they still owe, but that is not the same figure as project margin.',
      },
      {
        q: 'What does an agency pay?',
        a: 'NPR 499 per month on Premium if you want the reports, settlements and data health. NPR 299 on Plus covers invoicing, expenses and settings. There is no per-seat charge and no setup fee published; confirm current terms before paying.',
      },
    ],
  },
  {
    path: '/bikram-sambat-accounting',
    slug: 'bikram-sambat-accounting',
    crumb: 'BS dates',
    navLabel: 'Bikram Sambat dates',
    title: 'Accounting Software with Bikram Sambat Dates — Zeyks Book',
    description:
      'Enter dates in the Bikram Sambat calendar and keep the Gregorian date beside them. Zeyks Book converts both ways, caps each BS month to its real length, and prints reports in BS or AD for businesses in Nepal.',
    eyebrow: 'Dates',
    h1: 'Accounting software that reads Bikram Sambat',
    lead: 'Most software stores a date and shows you the Gregorian one. In Nepal the date a shop, an office and an accountant write down is usually Bikram Sambat. Zeyks Book lets you enter dates in the BS calendar, keeps the Gregorian equivalent beside them, and prints either.',
    sections: [
      {
        heading: 'Enter the date you actually work with',
        paragraphs: [
          'A BS date field takes year, month and day. The day list is capped to the real length of that month in that year — a 32-day month offers 32 days, a 29-day month offers 29 — and picking a day that no longer exists moves you to the last day that does. The Gregorian date it resolves to is printed underneath, so nothing about the conversion is hidden.',
        ],
      },
      {
        heading: 'Two readings of one date',
        paragraphs: [
          'The stored key is the ISO Gregorian date, because sorting, day-count arithmetic and overdue bands all need a calendar with fixed month lengths. Entry and reading happen in whichever calendar the device is set to. The same record answers both: a report header shows \u201c2082-03-15 BS \u00b7 2025-06-30 AD\u201d, and a screen set to AD shows the date it has always shown.',
          'You can change the reading calendar without touching the data. Nothing is re-entered when the preference changes, because there is only ever one date per record.',
        ],
      },
      {
        heading: 'Reports in the calendar you pick',
        paragraphs: [
          'A report period is a start date and an end date, and the picker works in either calendar. Pick a month in BS and the printed statement labels the range in BS with the Gregorian dates beside it, so the sheet is readable by whoever asked for it — the shop, the accountant, or a bank.',
        ],
      },
      {
        heading: 'A published table, with a stated end',
        paragraphs: [
          'BS month lengths are not a rule you can compute; they are published each year and vary. Zeyks Book ships the day-count table for BS 2000 through BS 2090, which covers roughly AD 1943 through 2034, and it is round-trip tested across the whole span.',
          'Outside that range the app stops rather than guesses: a date it cannot convert is shown as it was stored, not as a plausible-looking approximation.',
        ],
      },
    ],
    notForHeading: 'What the calendar side does not do',
    notFor: [
      'No BS 2091 and later — the day-count table currently ends at BS 2090.',
      'A BS date is a date, not a period. Zeyks Book does not derive a Nepali fiscal year for you; reports run over the range you pick.',
      'The interface is in English and BS month names print in Latin transliteration, not Devanagari.',
      'No panchang, festival or holiday calendar, and no auto-adjustment when a year\u2019s published lengths change.',
    ],
    faqs: [
      {
        q: 'Which calendar does Zeyks Book store?',
        a: 'The Gregorian date is the stored, sortable key, and the Bikram Sambat date is what you enter and what most screens show. Both come from the same day, so a record has one date with two readings rather than two fields that can disagree.',
      },
      {
        q: 'Can I run a report for a Nepali calendar period?',
        a: 'Yes. Reports take a start and an end date, and the period can be chosen in BS. The printed report labels the range in the calendar you are reading and shows the other calendar beside it.',
      },
      {
        q: 'Do BS months have fixed lengths?',
        a: 'No. A BS month can be 29, 30, 31 or 32 days, and which one it is depends on the year. Zeyks Book reads the lengths from a published table, which is why the day list changes when you change the month.',
      },
      {
        q: 'What date range is supported?',
        a: 'BS 2000 to BS 2090, roughly AD 1943 to 2034. Beyond that the converter has no published month lengths to work from, so the app shows the date as stored instead of inventing a conversion.',
      },
      {
        q: 'Does the time zone matter?',
        a: 'It does. "Today" is calculated for Asia/Kathmandu rather than the browser\u2019s zone, so a shop owner entering an invoice at 11 pm Nepal time does not get the next day\u2019s date because their laptop is set somewhere else.',
      },
    ],
  },
  {
    path: '/vat-reporting-nepal',
    slug: 'vat-reporting-nepal',
    crumb: 'VAT reporting',
    navLabel: 'VAT reporting',
    title: 'VAT Reporting Software for Businesses in Nepal — Zeyks Book',
    description:
      'Record VAT on sales, purchases and expenses, then run a VAT summary for any date range: taxable sales and purchases, output VAT, input VAT, and the net payable or credit carried forward, on printable A4.',
    eyebrow: 'VAT',
    h1: 'VAT reporting for Nepali businesses',
    lead: 'A Nepali VAT return asks for a small set of figures for a period: taxable sales, taxable purchases, the VAT you collected, the VAT you paid, and the net amount. Zeyks Book produces those from your posted entries, so they are not rebuilt in a spreadsheet every time a return is due.',
    sections: [
      {
        heading: 'The figures a return asks for',
        bullets: [
          'Taxable sales — the value of what you sold in the period, VAT excluded.',
          'Taxable purchases — the value of the stock you bought in it.',
          'Output VAT — the tax collected on your sales, owed onward.',
          'Input VAT — the tax you paid on purchases and expenses, which you can claim.',
          'The net figure — payable when output is larger, carried forward when input is.',
        ],
        paragraphs: [
          'The VAT summary report takes a date range and returns exactly those, with the business name, its PAN and the period printed in the header on A4.',
        ],
      },
      {
        heading: 'VAT only exists if the business is registered',
        paragraphs: [
          'Tax lines post only when the business is marked VAT-registered in Settings. A business that is not registered keeps tax-free books rather than a column of zeros. The rate defaults to 13% and is editable per business, and an invoice or bill line can be entered as VAT-inclusive or VAT-exclusive.',
        ],
      },
      {
        heading: 'Two accounts, not a memo',
        paragraphs: [
          'Output VAT is collected into a VAT payable account, a liability, because it is not your money once you have charged it. Input VAT is collected into a VAT receivable account, an asset, because it is money you can get back. They are ordinary accounts in the chart of accounts, so the trial balance and the balance sheet show them too.',
          'Because the summary reads those postings, an entry that has not been posted changes nothing — and a figure in the report can always be traced to the entries behind it.',
        ],
      },
      {
        heading: 'What the two VAT totals are measuring',
        paragraphs: [
          'Output VAT is read from the VAT payable account. Input VAT is read from the VAT receivable account, which purchases post to and which expenses post to when an expense carries tax — so both are included, and input VAT will usually be more than 13% of the taxable purchase figure.',
          'The taxable purchase figure itself comes from the cost-of-goods side of the ledger. That is worth knowing before anyone divides one total by the other and calls the difference an error.',
        ],
      },
      {
        heading: 'Who can run it',
        paragraphs: [
          'The VAT summary is part of the report set, so it is on the Premium plan at NPR 499 per month. The records behind it — sales, purchases and expenses with their tax amounts — are entered on Plus at NPR 299, which means you can keep the books on Plus and move to Premium at the point you want the statements.',
        ],
      },
    ],
    notForHeading: 'What Zeyks Book does not do for VAT',
    notFor: [
      'It is not IRD-approved or IRD-verified. The site publishes no approval status, and a printed VAT summary is a product output, not proof of anything.',
      'No e-billing integration, no CBMS connection, no submission and no filing. You file with the IRD; you use the report while doing it.',
      'One VAT rate per business. The app does not know which of your supplies are exempt or zero-rated, so a business with mixed ratings does the split itself.',
      'No VAT return deadlines, penalty or interest tracking.',
      'The report is a working document. Review it with an accountant before it goes anywhere statutory.',
    ],
    faqs: [
      {
        q: 'Is the VAT rate fixed at 13%?',
        a: '13% is the default, and each business sets its own rate in Settings. There is a single rate per business, so a shop that mixes exempt and taxable supplies has to separate them before entering the taxable ones.',
      },
      {
        q: 'Does Zeyks Book file my VAT return?',
        a: 'No. It produces a VAT summary for a date range from your posted journal entries. The return itself is prepared and filed by you or your accountant with the IRD.',
      },
      {
        q: 'Where does the input VAT figure come from?',
        a: 'From the VAT receivable account. Purchase entries post tax there when the business is registered, and expense entries post tax there when the expense carries it. Anything that did not reach that account is not in the summary.',
      },
      {
        q: 'Why is my input VAT larger than 13% of the taxable purchases?',
        a: 'Because the two totals read different parts of the ledger. Taxable purchases are the cost-of-goods side; input VAT is everything posted to the VAT receivable account, which also takes tax from expenses. They are not expected to be a clean ratio.',
      },
      {
        q: 'Is the VAT report ready to hand to the IRD?',
        a: 'It carries the figures a return asks for, printed on A4 with your PAN and the period. It is a working document produced by software with no IRD approval status — review it with your accountant before relying on it.',
      },
    ],
  },
];

/**
 * The intent page served at this path, or null.
 *
 * Takes whatever the router normalised, so `/Hallbook-Software/` and a path with
 * a query string still resolve to the page a crawler was sent to.
 */
export function intentPageForPath(pathname: string): IntentPage | null {
  const clean = (pathname || '/').split('?')[0]!.split('#')[0]!;
  const match = INTENT_PAGES.find((page) => page.path === clean || page.path === `/${clean.replace(/^\/+|\/+$/g, '')}`);
  return match ?? null;
}
