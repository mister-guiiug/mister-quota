// System tray icon. Shows a menu of accounts (worst-status first), opens
// the main window on double-click, exposes "Sync all", "Quit". Refreshable
// so it reflects changes after CRUD or scheduled syncs.

import { Tray, Menu, nativeImage, app, type BrowserWindow } from 'electron';
import type { Storage } from './db';
import { computeAccountState } from '../shared/calc';
import type { AccountState } from '../shared/types';

export interface TrayController {
  refresh: () => void;
  destroy: () => void;
}

export function buildTray(
  storage: Storage,
  getMainWindow: () => BrowserWindow | null,
  syncAll: () => Promise<void>,
): TrayController {
  // Use a tiny generated 16×16 placeholder (user can swap for a packaged
  // PNG later). nativeImage.createEmpty() works everywhere; we add a
  // minimal data URL so the icon isn't fully invisible on macOS / Linux.
  const blank16 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAEElEQVR4nGNgGAWjYBSAAAADCgABZl1cZAAAAABJRU5ErkJggg==';
  const icon = nativeImage.createFromDataURL(blank16);
  const tray = new Tray(icon);
  tray.setToolTip('Mister Quota');

  function rebuild(): void {
    const accounts = storage.listAccounts();
    const states: AccountState[] = accounts.map((a) =>
      computeAccountState({
        account: a,
        entries: storage.listEntries(a.id),
        historicalEntries: storage.listEntries(a.id),
      }),
    );
    states.sort((a, b) => b.deltaPct - a.deltaPct); // worst (most behind) first

    const accountItems =
      states.length === 0
        ? [{ label: 'Aucun compte', enabled: false }]
        : states.slice(0, 10).map((s) => ({
            label: `${statusEmoji(s.status)}  ${s.account.name} — ${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%`,
            click: () => {
              const win = getMainWindow();
              if (win) {
                win.show();
                win.focus();
              }
            },
          }));

    const menu = Menu.buildFromTemplate([
      { label: 'Mister Quota', enabled: false },
      { type: 'separator' },
      ...accountItems,
      { type: 'separator' },
      { label: 'Synchroniser tout', click: () => syncAll() },
      {
        label: 'Ouvrir',
        click: () => {
          const w = getMainWindow();
          if (w) {
            w.show();
            w.focus();
          }
        },
      },
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  }

  tray.on('double-click', () => {
    const w = getMainWindow();
    if (w) {
      w.show();
      w.focus();
    }
  });
  rebuild();

  return {
    refresh: rebuild,
    destroy: () => tray.destroy(),
  };
}

function statusEmoji(s: AccountState['status']): string {
  switch (s) {
    case 'on_track':
      return '🟢';
    case 'ahead':
      return '🔵';
    case 'behind':
      return '🟡';
    case 'over_quota':
      return '🔴';
    case 'period_ended':
      return '⚪';
  }
}
