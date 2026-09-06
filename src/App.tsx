import { useEffect, useRef, useState } from 'react';
import { Dashboard } from './views/Dashboard';
import { AccountForm } from './views/AccountForm';
import { AccountDetail } from './views/AccountDetail';
import { SyncLog } from './views/SyncLog';
import { ObservabilityBoundary } from '@mister-guiiug/dev-pwa-config/react/error-boundary';
import { Toaster } from './components/Toaster';
import { ConfirmHost, confirmDialog } from './components/ConfirmDialog';
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
  const importInputRef = useRef<HTMLInputElement>(null);
  const refreshAll = useAppStore((s) => s.refreshAll);
  const loadSkills = useAppStore((s) => s.loadSkills);

  useEffect(() => {
    const boot = (): void => {
      void refreshAll();
      void loadSkills();
    };
    if (typeof window !== 'undefined' && !window.api) {
      import('./previewShim').then((m) => {
        m.installPreviewShim();
        boot();
      });
    } else {
      boot();
    }
  }, [refreshAll, loadSkills]);

  const handleExport = async (format: 'json' | 'csv'): Promise<void> => {
    try {
      const p = await window.api.exportData(format);
      if (p) toast.success(`Exporté vers ${p}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export échoué');
    }
  };

  // Restauration. Le fichier est validé par le processus principal AVANT toute
  // écriture : un fichier d'une autre application repart en erreur sans que la
  // base ait bougé. La confirmation n'est demandée que pour un fichier valide
  // sur une base non vide — et elle dit ce qu'elle emporte.
  const handleImport = async (file: File): Promise<void> => {
    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fichier illisible');
      return;
    }
    const restored = async (accounts: number, entries: number): Promise<void> => {
      toast.success(`Sauvegarde restaurée : ${accounts} compte(s), ${entries} relevé(s)`);
      setView({ kind: 'dashboard' });
      await refreshAll();
    };

    const first = await window.api.importBackup(text);
    if (first.ok) return restored(first.accounts, first.entries);
    if (first.reason !== 'needs_confirmation') {
      toast.error(`Restauration refusée : ${first.error}`);
      return;
    }

    const ok = await confirmDialog({
      title: 'Remplacer les données actuelles ?',
      message:
        `Cette base contient ${first.existing.accounts} compte(s) et ${first.existing.entries} relevé(s) ; ` +
        `la sauvegarde en apporte ${first.incoming.accounts} et ${first.incoming.entries}. Tout est remplacé, ` +
        `journal des synchronisations compris. Les clés d'API ne sont pas dans une sauvegarde : elles ` +
        `restent sur cette machine et seront à ressaisir pour les comptes restaurés.`,
      confirmLabel: 'Restaurer',
      destructive: true,
    });
    if (!ok) {
      toast.info('Restauration annulée — rien n’a été modifié');
      return;
    }

    const confirmed = await window.api.importBackup(text, { confirmed: true });
    if (confirmed.ok) return restored(confirmed.accounts, confirmed.entries);
    toast.error(
      `Restauration refusée : ${
        confirmed.reason === 'needs_confirmation' ? 'confirmation non prise en compte' : confirmed.error
      }`,
    );
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
        <button onClick={() => handleExport('json')}>Sauvegarder (JSON)</button>
        <button onClick={() => handleExport('csv')}>Exporter (CSV)</button>
        <button onClick={() => importInputRef.current?.click()}>Restaurer une sauvegarde</button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          data-testid="import-backup"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            // Réarmer l'input avant tout `await` : sans cela, restaurer deux
            // fois le même fichier de suite ne déclencherait pas d'événement.
            e.target.value = '';
            if (file) await handleImport(file);
          }}
        />
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
