import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { AccountForm } from './views/AccountForm';
import { AccountDetail } from './views/AccountDetail';
import { SyncLog } from './views/SyncLog';
import { ObservabilityBoundary } from '@mister-guiiug/dev-pwa-config/react/error-boundary';
import { Toaster } from './components/Toaster';
import { ConfirmHost } from './components/ConfirmDialog';
import { useAppStore } from './store';
import { toast } from './toast';
import type { Account } from '@shared/types';
import { createLogger } from '@mister-guiiug/dev-pwa-config/logger';

const log = createLogger('App');

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
      import('./previewShim').then((m) => {
        m.installPreviewShim();
        refreshAll();
      });
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
        <button
          className={view.kind === 'dashboard' ? 'active' : ''}
          onClick={() => setView({ kind: 'dashboard' })}
        >
          Dashboard
        </button>
        <button onClick={() => setView({ kind: 'new' })}>+ Nouveau compte</button>
        <button
          className={view.kind === 'syncLog' ? 'active' : ''}
          onClick={() => setView({ kind: 'syncLog' })}
        >
          Journal des syncs
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={() => handleExport('json')}>Export JSON</button>
        <button onClick={() => handleExport('csv')}>Export CSV</button>
      </aside>

      <main className="main">
        {/* Frontière d'erreur du socle : elle journalise le crash (tampon
            circulaire local) et affiche une référence de session à citer au
            support. Le renderer n'avait jusqu'ici qu'un console.error, invisible
            dans une application empaquetée. */}
        <ObservabilityBoundary
          title="Une erreur est survenue"
          onError={(error, info) => log.error('Renderer error boundary caught', { error, details: [info] })}
        >
          {view.kind === 'dashboard' && (
            <Dashboard
              onOpen={(id) => setView({ kind: 'detail', accountId: id })}
              onEdit={(account) => setView({ kind: 'edit', account })}
            />
          )}
          {view.kind === 'new' && (
            <AccountForm
              onSaved={() => setView({ kind: 'dashboard' })}
              onCancel={() => setView({ kind: 'dashboard' })}
            />
          )}
          {view.kind === 'edit' && (
            <AccountForm
              initial={view.account}
              onSaved={() => setView({ kind: 'dashboard' })}
              onCancel={() => setView({ kind: 'dashboard' })}
            />
          )}
          {view.kind === 'detail' && (
            <AccountDetail
              accountId={view.accountId}
              onBack={() => setView({ kind: 'dashboard' })}
              onEdit={(a) => setView({ kind: 'edit', account: a })}
            />
          )}
          {view.kind === 'syncLog' && <SyncLog onBack={() => setView({ kind: 'dashboard' })} />}
        </ObservabilityBoundary>
      </main>

      <Toaster />
      <ConfirmHost />
    </>
  );
}
