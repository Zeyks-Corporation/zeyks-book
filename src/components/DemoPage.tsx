import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, XCircle } from 'lucide-react';
import { ViewTab } from '../types';
import { useDemoBooks } from '../state/useDemoBooks';
import { Sidebar, Header } from './Shell';
import type { TxnKind } from './TransactionModal';
import { Button } from './ui';
import { readCalendarPreference, writeCalendarPreference } from '../lib/preferences';
import type { CalendarPreference } from '../lib/preferences';
import { isSupported, unsupportedMessage } from '../lib/capabilities';
import type { Capability } from '../lib/capabilities';

const DashboardView = lazy(() => import('./DashboardView').then((m) => ({ default: m.DashboardView })));
const DocumentsView = lazy(() => import('./DocumentsView').then((m) => ({ default: m.DocumentsView })));
const ReportsView = lazy(() => import('./ReportsView').then((m) => ({ default: m.ReportsView })));
const HealthView = lazy(() => import('./HealthView').then((m) => ({ default: m.HealthView })));
const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })));
const TransactionModal = lazy(() => import('./TransactionModal').then((m) => ({ default: m.TransactionModal })));

const TITLES: Record<ViewTab, string> = {
  dashboard: 'Dashboard', sales: 'Sales', purchases: 'Purchases', expenses: 'Expenses',
  payments: 'Payments', reports: 'Reports', health: 'Data health', settings: 'Settings',
  inventory: 'Inventory', tools: 'Premium tools',
};

const CAPABILITY_FOR_TXN: Record<TxnKind, Capability> = {
  sale: 'sales', purchase: 'purchases', expense: 'expenses', payment: 'payments',
};

const TXN_LABELS: Record<TxnKind, string> = {
  sale: 'Recording a sale', purchase: 'Recording a purchase',
  expense: 'Recording an expense', payment: 'Recording a settlement',
};

const Toast: React.FC<{ message: string; ok: boolean; onDismiss: () => void }> = ({ message, ok, onDismiss }) => {
  useEffect(() => {
    const t = window.setTimeout(onDismiss, 4500);
    return () => window.clearTimeout(t);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 rounded-full border px-5 py-3 text-[13px] leading-[18px] shadow-lg max-w-md ${
        ok ? 'bg-[var(--bg-tertiary)] border-[var(--separator)] text-[var(--label)]' : 'bg-[var(--destructive)] border-[var(--destructive)] text-white'
      }`}
    >
      {ok ? <CheckCircle2 size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" /> : <XCircle size={14} strokeWidth={1.8} className="shrink-0" aria-hidden="true" />}
      <span>{message}</span>
    </div>
  );
};

export const DemoPage: React.FC<{
  currentPath?: string;
  navigate?: (to: string) => void;
  onSignIn: () => void;
}> = ({ onSignIn }) => {
  const books = useDemoBooks();
  const { defaultRange, integrityIssues } = books;

  const [activeTab, setActiveTab] = useState<ViewTab>('dashboard');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [range, setRange] = useState(defaultRange);
  const [rangeTouched, setRangeTouched] = useState(false);
  const [calendar, setCalendar] = useState<CalendarPreference>(() => readCalendarPreference());

  const changeCalendar = useCallback((next: CalendarPreference) => {
    setCalendar(next);
    writeCalendarPreference(next);
  }, []);

  const [toast, setToast] = useState<{ message: string; ok: boolean; key: number } | null>(null);
  const [txnModal, setTxnModal] = useState<TxnKind | null>(null);
  const [settleFor, setSettleFor] = useState<
    { documentId: string; direction: 'INCOMING' | 'OUTGOING' } | undefined
  >(undefined);

  useEffect(() => {
    if (!rangeTouched) setRange(defaultRange);
  }, [defaultRange, rangeTouched]);

  const updateRange = useCallback((r: typeof range) => {
    setRange(r);
    setRangeTouched(true);
  }, []);

  const notify = useCallback((message: string, ok: boolean) => {
    setToast({ message, ok, key: Date.now() });
  }, []);

  const openQuickAction = useCallback((kind: TxnKind) => {
    if (!isSupported(CAPABILITY_FOR_TXN[kind])) {
      notify(unsupportedMessage(TXN_LABELS[kind]), false);
      return;
    }
    setSettleFor(undefined);
    setTxnModal(kind);
  }, [notify]);

  const openSettle = useCallback((documentId: string, direction: 'INCOMING' | 'OUTGOING') => {
    if (!isSupported('payments')) {
      notify(unsupportedMessage('Recording a settlement'), false);
      return;
    }
    setSettleFor({ documentId, direction });
    setTxnModal('payment');
  }, [notify]);

  const currentDocKind = activeTab === 'sales' ? 'sales' : activeTab === 'purchases' ? 'purchases'
    : activeTab === 'expenses' ? 'expenses' : activeTab === 'payments' ? 'payments' : null;

  const quickActionForTab: Record<string, TxnKind> = {
    sales: 'sale', purchases: 'purchase', expenses: 'expense', payments: 'payment',
  };

  const headerActions = useMemo(() => {
    if (!currentDocKind) return null;
    const kind = quickActionForTab[currentDocKind]!;
    const supported = isSupported(CAPABILITY_FOR_TXN[kind]);
    return (
      <Button
        variant="primary"
        onClick={() => openQuickAction(kind)}
        disabled={!supported}
        title={supported ? undefined : unsupportedMessage(TXN_LABELS[kind])}
      >
        <Plus size={13} aria-hidden="true" /> New
      </Button>
    );
  }, [currentDocKind, openQuickAction]);



  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] flex flex-col">
      {/* ── Main Studio Layout ── */}
      <div className="flex-1 relative">
        <Sidebar
          currentTab={activeTab}
          onSelect={(t) => { setActiveTab(t); setMobileSidebarOpen(false); }}
          businessName={`${books.business.businessName} (Demo)`}
          isOpenMobile={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          issueCount={integrityIssues.filter((i) => i.severity === 'ERROR').length}
        />

        <div className="lg:pl-60">
          <Header
            title={TITLES[activeTab]}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            actions={headerActions}
          />

          <main>
            <Suspense fallback={<div className="px-6 py-8 text-sm text-[var(--label-secondary)]">Loading demo section…</div>}>
            {activeTab === 'dashboard' && (
              <DashboardView
                books={books}
                range={range}
                onRangeChange={updateRange}
                calendar={calendar}
                onQuickAction={openQuickAction}
                onGoToHealth={() => setActiveTab('health')}
                hideHealthBanner={false}
              />
            )}
            {currentDocKind && (
              <DocumentsView
                kind={currentDocKind}
                books={books}
                calendar={calendar}
                onNew={() => openQuickAction(quickActionForTab[currentDocKind]!)}
                onCollect={() => {
                  notify('Online payment collection is disabled in offline demo mode.', false);
                }}
                onReceive={(saleId) => openSettle(saleId, 'INCOMING')}
                onSettle={(purchaseId) => openSettle(purchaseId, 'OUTGOING')}
                onDone={notify}
              />
            )}
            {activeTab === 'reports' && (
              <ReportsView
                books={books}
                range={range}
                onRangeChange={updateRange}
                calendar={calendar}
              />
            )}
            {activeTab === 'health' && (
              <HealthView books={books} onDone={notify} />
            )}
            {activeTab === 'settings' && (
              <SettingsView
                books={books}
                onDone={notify}
                calendar={calendar}
                onCalendarChange={changeCalendar}
                onSignOut={async () => { onSignIn(); }}
                signingOut={false}
              />
            )}
            {activeTab === 'tools' && (
              <section className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
                <h1 className="text-2xl font-semibold">Premium business tools</h1>
                <p className="text-sm text-[var(--label-secondary)]">These modules use your signed-in business database, so they are available in a Premium account rather than the offline sample book.</p>
                <ul className="grid gap-2 text-sm sm:grid-cols-2">
                  {['Budgets', 'Bank reconciliation', 'Recurring invoices', 'Supporting files', 'Fixed assets and depreciation'].map((label) => (
                    <li key={label} className="rounded-lg border border-[var(--separator)] bg-[var(--bg)] p-3">{label}</li>
                  ))}
                </ul>
              </section>
            )}
            </Suspense>
          </main>
        </div>

        {/* ── Transaction Modal ── */}
        {txnModal !== null && <Suspense fallback={null}><TransactionModal
          isOpen={txnModal !== null}
          kind={txnModal ?? 'sale'}
          onClose={() => { setTxnModal(null); setSettleFor(undefined); }}
          books={books}
          calendar={calendar}
          onDone={notify}
          preselectDocumentId={settleFor?.documentId}
          preselectDirection={settleFor?.direction}
        /></Suspense>}

        {toast && <Toast key={toast.key} message={toast.message} ok={toast.ok} onDismiss={() => setToast(null)} />}
      </div>
    </div>
  );
};
