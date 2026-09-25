/**
 * Cloud capability matrix.
 *
 * Sales (`post_sale`), purchases (`post_purchase`), expenses (`post_expense`),
 * settlements (`post_payment`), voiding (`void_document` for documents,
 * `void_payment` for settlements) and online collection
 * (`initiate_gateway_txn` + `settle_gateway_txn` for eSewa/Khalti) are backed by
 * Cloud Functions / Firestore. Chart-of-accounts edits and backup restore have no Function yet, so
 * their write paths would change React state only and be lost on refresh. Those
 * write paths are disabled in cloud mode until their RPCs ship.
 *
 * Gateways being available does NOT mean the browser can post money: the only
 * thing these two RPCs let a member do is record a provider interaction and ask
 * the database to settle it, and the database re-validates the provider's
 * answer, the amount, the currency and the invoice's outstanding balance before
 * it writes a single row.
 *
 * Reads are NOT gated: existing cloud rows stay browsable everywhere.
 */

export const CAPABILITIES = {
  sales: true,
  purchases: true,
  expenses: true,
  payments: true,
  voiding: true,
  gateway: true,
  accounts: false,
  restore: false,
  erase: false,
} as const;

/**
 * Document lists the void RPCs cover, so the UI reads availability from here
 * rather than hard-coding a check per view.
 *
 * A settlement with its own journal entry (a `post_payment` row) can be voided
 * on its own — that is `void_payment`. A settlement recorded as part of its
 * document (an upfront payment, which shares the sale's or purchase's entry)
 * cannot: reversing that entry would reverse the whole document, so the row is
 * refused by the server and dimmed by `isVoidablePayment`.
 */
export const VOIDABLE_DOCUMENTS = {
  sales: true,
  purchases: true,
  expenses: true,
  payments: true,
} as const;

export type VoidableDocumentList = keyof typeof VOIDABLE_DOCUMENTS;

/** True when voiding is cloud-backed for this document list. */
export function isVoidable(kind: VoidableDocumentList): boolean {
  return CAPABILITIES.voiding && VOIDABLE_DOCUMENTS[kind];
}

export type Capability = keyof typeof CAPABILITIES;

export function isSupported(cap: Capability): boolean {
  return CAPABILITIES[cap];
}

/** A user-facing explanation for a not-yet-cloud-backed write action. */
export function unsupportedMessage(label: string): string {
  return `${label} is not available yet — it is not saved to the cloud yet, so nothing would be stored.`;
}

export interface UnsupportedResult {
  ok: false;
  message: string;
}

/** Uniform failure result for an unsupported action (never reports success). */
export function unsupported(cap: Capability, label: string): UnsupportedResult {
  void cap;
  return { ok: false, message: unsupportedMessage(label) };
}
