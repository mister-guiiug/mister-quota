import { useEffect, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { AccountForm } from './views/AccountForm';
import { AccountDetail } from './views/AccountDetail';
import type { Account } from '@shared/types';

type View =
  | { kind: 'dashboard' }
  | { kind: 'new' }
  | { kind: 'edit'; account: Account }
  | { kind: 'detail'; accountId: string };

export function App(): JSX.Element {
  const [view, setView] = useState<View>({ kind: 'dashboard' });
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  // If running in pure-browser preview (no electron preload), shim window.api
  // so the UI renders sample data. The main process replaces this in the real app.
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.api) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      import('./previewShim').then((m) => { m.installPreviewShim(); refresh(); });
    }
  }, []);

  return (
    <>
      <aside className="sidebar">
        <h1>MISTER QUOTA</h1>
        <button className={view.kind === 'dashboard' ? 'active' : ''} onClick={() => setView({ kind: 'dashboard' })}>Dashboard</button>
        <button onClick={() => setView({ kind: 'new' })}>+ Nouveau compte</button>
        <div style={{ flex: 1 }} />
        <button onClick={() => window.api.exportData('json').then((p) => p && alert(`Exporté: ${p}`))}>Export JSON</button>
        <button onClick={() => window.api.exportData('csv').then((p) => p && alert(`Exporté: ${p}`))}>Export CSV</button>
      </aside>

      <main className="main">
        {view.kind === 'dashboard' && (
          <Dashboard
            key={refreshKey}
            onOpen={(id) => setView({ kind: 'detail', accountId: id })}
            onEdit={(account) => setView({ kind: 'edit', account })}
          />
        )}
        {view.kind === 'new' && (
          <AccountForm onSaved={() => { refresh(); setView({ kind: 'dashboard' }); }} onCancel={() => setView({ kind: 'dashboard' })} />
        )}
        {view.kind === 'edit' && (
          <AccountForm initial={view.account} onSaved={() => { refresh(); setView({ kind: 'dashboard' }); }} onCancel={() => setView({ kind: 'dashboard' })} />
        )}
        {view.kind === 'detail' && (
          <AccountDetail
            accountId={view.accountId}
            onBack={() => setView({ kind: 'dashboard' })}
            onEdit={(a) => setView({ kind: 'edit', account: a })}
          />
        )}
      </main>
    </>
  );
}
