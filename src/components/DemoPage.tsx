import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, RotateCcw, XCircle } from 'lucide-react';
import { ViewTab } from '../types';
import { useDemoBooks } from '../state/useDemoBooks';
import { Sidebar, Header } from './Shell';
import { DashboardView } from './DashboardView';
import { DocumentsView } from './DocumentsView';
import { ReportsView } from './ReportsView';
import { SettingsView } from './SettingsView';
import { TransactionModal, TxnKind } from './TransactionModal';
import { Button } from './ui';
import { readCalendarPreference, writeCalendarPreference } from '../lib/preferences';
import type { CalendarPreference } from '../lib/preferences';
import { isSupported, unsupportedMessage } from '../lib/capabilities';
import type { Capability } from '../lib/capabilities';

const TITLES: Record<ViewTab, string> = {
  dashboard: 'Dashboard', sales: 'Sales', purchases: 'Purchases', expenses: 'Expenses',
  payments: 'Payments', reports: 'Reports', health: 'Data health', settings: 'Settings',
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
  const { defaultRange, integrityIssues, resetAll } = books;

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

  const handleResetDemo = useCallback(() => {
    resetAll();
    notify('Demo environment reset to initial state. Local storage refreshed.', true);
  }, [notify, resetAll]);

  return (
    <div className="min-h-screen bg-[var(--bg-secondary)] flex flex-col">
      {/* ── Top Demo Mode Info Banner ── */}
      <div className="sticky top-0 z-40 bg-[var(--accent)] text-white px-4 py-2.5 shadow-md flex flex-wrap items-center justify-between gap-3 text-[13px] border-b border-white/10">
        <div className="flex items-center gap-2.5 font-medium">
          <span className="flex h-6 px-2.5 items-center justify-center rounded-full bg-white/20 text-white font-bold text-[11px] uppercase tracking-wider">
            Demo Mode
          </span>
          <span className="hidden sm:inline text-white/90">
            Interactive Accounting Studio — All data is saved safely in your browser (local browser storage). No Supabase database involved.
          </span>
          <span className="sm:hidden text-white/90">
            Interactive Studio (Local Storage only)
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleResetDemo}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[12px] font-semibold text-white hover:bg-white/25 active:scale-95 transition-all"
            title="Reset all demo entries to sample snapshot"
          >
            <RotateCcw size={12} strokeWidth={2.2} />
            <span>Reset Demo Data</span>
          </button>

          <button
            type="button"
            onClick={onSignIn}
            className="inline-flex items-center gap-1 rounded-full bg-white text-[var(--accent)] px-3 py-1 text-[12px] font-bold shadow-xs hover:bg-white/90 active:scale-95 transition-all"
          >
            <span>Sign In / Full App</span>
          </button>
        </div>
      </div>

      {/* ── Main Studio Layout ── */}
      <div className="flex-1 relative">
        <Sidebar
          currentTab={activeTab}
          onSelect={(t) => { setActiveTab(t); setMobileSidebarOpen(false); }}
          businessName={`${books.business.businessName} (Demo)`}
          isOpenMobile={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          issueCount={integrityIssues.filter((i) => i.severity === 'ERROR').length}
          hideTabs={['health']}
        />

        <div className="lg:pl-60">
          <Header
            title={TITLES[activeTab]}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            actions={headerActions}
          />

          <main>
            {activeTab === 'dashboard' && (
              <DashboardView
                books={books}
                range={range}
                onRangeChange={updateRange}
                calendar={calendar}
                onQuickAction={openQuickAction}
                onGoToHealth={() => {}}
                hideHealthBanner={true}
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
          </main>
        </div>

        {/* ── Transaction Modal ── */}
        <TransactionModal
          isOpen={txnModal !== null}
          kind={txnModal ?? 'sale'}
          onClose={() => { setTxnModal(null); setSettleFor(undefined); }}
          books={books}
          calendar={calendar}
          onDone={notify}
          preselectDocumentId={settleFor?.documentId}
          preselectDirection={settleFor?.direction}
        />

        {toast && <Toast key={toast.key} message={toast.message} ok={toast.ok} onDismiss={() => setToast(null)} />}
      </div>
    </div>
  );
};
