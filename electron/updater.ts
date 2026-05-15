// Auto-updater wired to electron-updater. The runtime is opt-in via env
// var so a dev build never tries to talk to GitHub Releases.
//
// To enable:
//   1. Configure publish in package.json's "build" block:
//        "publish": [{ "provider": "github", "owner": "mister-guiiug", "repo": "mister-quota" }]
//   2. Generate signing certs (Windows: code-signing cert; macOS: Developer ID
//      + notarization). Reference docs: https://www.electron.build/code-signing
//   3. CI: pass GH_TOKEN with write permission on releases when running
//      `electron-builder --publish always`. The CI's package job is already
//      configured to upload artifacts; add `--publish always` to push them
//      as a Release.
//   4. At runtime set env MISTER_QUOTA_AUTO_UPDATE=1 to enable in-app
//      checking + downloading.

import { app } from 'electron';
import type { Logger } from './log';

interface UpdaterDeps {
  log: Logger;
  notify: (title: string, body: string) => void;
}

export async function setupAutoUpdater({ log, notify }: UpdaterDeps): Promise<void> {
  if (!process.env.MISTER_QUOTA_AUTO_UPDATE) return;
  if (!app.isPackaged) {
    log.info('autoUpdater: skipped (running unpackaged)');
    return;
  }
  try {
    // Lazy-required so the dev environment doesn't break if electron-updater
    // is not installed yet.
    const { autoUpdater } = await import('electron-updater');
    autoUpdater.logger = {
      info: (m: string) => log.info(`updater: ${m}`),
      warn: (m: string) => log.info(`updater warn: ${m}`),
      error: (m: string) => log.error(`updater error: ${m}`),
      debug: () => {},
    };
    autoUpdater.on('update-available', (info) => {
      notify('Mise à jour disponible', `Version ${info.version} en téléchargement.`);
    });
    autoUpdater.on('update-downloaded', (info) => {
      notify('Mise à jour prête', `Version ${info.version} sera installée au prochain redémarrage.`);
    });
    autoUpdater.on('error', (err) => log.error('autoUpdater error', err));
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (err) {
    log.error('autoUpdater initialization failed', err);
  }
}
