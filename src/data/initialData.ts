import { Account, BusinessProfile } from '../types';
import { ACCOUNT_CODES } from '../services/accountingEngine';

/**
 * A fresh book. No personal details are baked in — the old build shipped with
 * a real Gmail address and a fictional Kathmandu trader hard-coded into it.
 */

export const emptyBusiness: BusinessProfile = {
  id: 'biz_local',
  userId: 'local',
  businessName: '',
  ownerName: '',
  email: '',
  phone: '',
  panNumber: '',
  address: '',
  city: '',
  currency: 'NPR',
  currencySymbol: 'NPR',
  timezone: 'Asia/Kathmandu',
  fiscalYearStartMonth: 4, // Shrawan
  vatRegistered: false,
  vatRate: 13,
  trackInventory: false,
  createdAt: new Date().toISOString(),
};

const acc = (
  code: string, name: string, type: Account['type'],
  description: string, systemAccount = false,
): Account => ({
  id: `acc_${code}`, businessId: 'biz_local', code, name, type,
  description, isActive: true, systemAccount,
});

export const defaultAccounts: Account[] = [
  // Assets
  acc(ACCOUNT_CODES.CASH, 'Cash in hand', 'ASSET', 'Notes and coins on the premises', true),
  acc(ACCOUNT_CODES.BANK, 'Bank account', 'ASSET', 'Current or operating bank account', true),
  acc(ACCOUNT_CODES.RECEIVABLE, 'Accounts receivable', 'ASSET', 'Money customers still owe you', true),
  acc(ACCOUNT_CODES.ESEWA, 'eSewa wallet', 'ASSET', 'eSewa settlement balance', true),
  acc(ACCOUNT_CODES.KHALTI, 'Khalti wallet', 'ASSET', 'Khalti settlement balance', true),
  acc(ACCOUNT_CODES.INVENTORY, 'Inventory', 'ASSET', 'Stock bought but not yet sold', true),
  acc(ACCOUNT_CODES.VAT_RECEIVABLE, 'VAT receivable (input tax)', 'ASSET', 'VAT paid on purchases, reclaimable', true),

  // Liabilities
  acc(ACCOUNT_CODES.PAYABLE, 'Accounts payable', 'LIABILITY', 'Money you owe suppliers', true),
  acc(ACCOUNT_CODES.VAT_PAYABLE, 'VAT payable (output tax)', 'LIABILITY', 'VAT collected on sales, owed to the IRD', true),

  // Equity
  acc(ACCOUNT_CODES.CAPITAL, "Owner's capital", 'EQUITY', 'Money the owner put into the business', true),
  acc(ACCOUNT_CODES.RETAINED, 'Retained earnings', 'EQUITY', 'Profit carried forward from earlier years', true),

  // Revenue
  acc(ACCOUNT_CODES.SALES, 'Sales revenue', 'REVENUE', 'Income from goods and services, net of VAT', true),
  acc('4020', 'Other income', 'REVENUE', 'Interest, rebates and one-off receipts'),

  // Cost of sales
  acc(ACCOUNT_CODES.COGS, 'Cost of goods sold', 'EXPENSE', 'What the goods you sold cost you', true),

  // Operating expenses
  acc('5020', 'Office and general', 'EXPENSE', 'Stationery, tea, printing, sundries'),
  acc('5030', 'Utilities and internet', 'EXPENSE', 'Electricity, water, broadband'),
  acc('5040', 'Rent', 'EXPENSE', 'Shop, office or warehouse rent'),
  acc('5050', 'Transport and freight', 'EXPENSE', 'Delivery, courier and vehicle costs'),
  acc('5060', 'Salaries and wages', 'EXPENSE', 'Staff pay and allowances'),
  acc('5070', 'Bank and gateway charges', 'EXPENSE', 'Bank fees, eSewa and Khalti commission'),
  acc('5080', 'Other expenses', 'EXPENSE', 'Anything that does not fit elsewhere'),
];
