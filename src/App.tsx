import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { AccountForm } from './views/AccountForm';
import { AccountDetail } from './views/AccountDetail';
import { SyncLog } from './views/SyncLog';
import { Toaster } from './components/Toaster';
import { ConfirmHost } from './components/ConfirmDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAppStore } from './store';
import { toast } from './toast';
import type { Account } from '@shared/types';

type View =
  | { kind: 'dashboard' }
  | { kind: 'new' }
  | { kind: 'edit'; account: Account }
  | { kind: 'detail'; accountId: string }
  | { kind: 'syncLog' };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const refreshAll = useAppStore((s) => s.refreshAll);

  useEffect(() => {
    if (typeof window !== 'undefined' && !window.api) {
      import('./previewShim').then((m) => { m.installPreviewShim(); refreshAll(); });
    } else {
      refreshAll();
    }
  }, [refreshAll]);

  const handleExport = async (format: 'json' | 'csv'): Promise<void> => {
    try {
      const p = await window.api.exportData(format);
      if (p) toast.success(`Exporté vers ${p}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export échoué');
    }
  };

  return (
    <>
      <aside className="sidebar">
        <h1>MISTER QUOTA</h1>
        <button className={view.kind === 'dashboard' ? 'active' : ''} onClick={() => setView({ kind: 'dashboard' })}>Dashboard</button>
        <button onClick={() => setView({ kind: 'new' })}>+ Nouveau compte</button>
        <button className={view.kind === 'syncLog' ? 'active' : ''} onClick={() => setView({ kind: 'syncLog' })}>Journal des syncs</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => handleExport('json')}>Export JSON</button>
        <button onClick={() => handleExport('csv')}>Export CSV</button>
      </aside>

      <main className="main">
        <ErrorBoundary>
          {view.kind === 'dashboard' && (
            <Dashboard
              onOpen={(id) => setView({ kind: 'detail', accountId: id })}
              onEdit={(account) => setView({ kind: 'edit', account })}
            />
          )}
          {view.kind === 'new' && (
            <AccountForm onSaved={() => setView({ kind: 'dashboard' })} onCancel={() => setView({ kind: 'dashboard' })} />
          )}
          {view.kind === 'edit' && (
            <AccountForm initial={view.account} onSaved={() => setView({ kind: 'dashboard' })} onCancel={() => setView({ kind: 'dashboard' })} />
          )}
          {view.kind === 'detail' && (
            <AccountDetail
              accountId={view.accountId}
              onBack={() => setView({ kind: 'dashboard' })}
              onEdit={(a) => setView({ kind: 'edit', account: a })}
            />
          )}
          {view.kind === 'syncLog' && (
            <SyncLog onBack={() => setView({ kind: 'dashboard' })} />
          )}
        </ErrorBoundary>
      </main>

      <Toaster />
      <ConfirmHost />
    </>
  );
}
