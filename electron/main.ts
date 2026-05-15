import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Storage } from './db';
import { SecretsStore } from './secrets';
import { Logger } from './log';
import { findSkill, SKILLS } from './skills';
import { computeAccountState } from '../shared/calc';
import { IPC } from '../shared/ipc';
import type { Account, AccountState, UsageEntry } from '../shared/types';

const log = new Logger();
const storage = new Storage(log);
const secrets = new SecretsStore();

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';
const isDev = !app.isPackaged;

async function createWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mister Quota',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (isDev) {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // From dist-electron/electron/main.js → ../../dist/index.html
    await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }
  return win;
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  await log.open(userData);
  log.info(`mister-quota starting; userData=${userData}`);
  await storage.open(userData);
  await secrets.open(userData);

  registerIpcHandlers();

  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  storage.close();
  if (process.platform !== 'darwin') app.quit();
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listAccounts, () => storage.listAccounts());
  ipcMain.handle(IPC.getAccount, (_e, id: string) => storage.getAccount(id));
  ipcMain.handle(IPC.upsertAccount, (_e, a: Account) => storage.upsertAccount(a));
  ipcMain.handle(IPC.deleteAccount, async (_e, id: string) => {
    storage.deleteAccount(id);
    await secrets.deleteForAccount(id);
  });

  ipcMain.handle(IPC.listEntries, (_e, accountId: string) => storage.listEntries(accountId));
  ipcMain.handle(IPC.insertEntry, (_e, entry: UsageEntry) => storage.insertEntry(entry));
  ipcMain.handle(IPC.deleteEntry, (_e, id: string) => storage.deleteEntry(id));

  ipcMain.handle(IPC.computeState, (_e, accountId: string): AccountState | null => {
    const account = storage.getAccount(accountId);
    if (!account) return null;
    const allEntries = storage.listEntries(accountId);
    return computeAccountState({ account, entries: allEntries, historicalEntries: allEntries });
  });

  ipcMain.handle(IPC.computeAllStates, (): AccountState[] => {
    const accounts = storage.listAccounts();
    return accounts.map((a) => {
      const allEntries = storage.listEntries(a.id);
      return computeAccountState({ account: a, entries: allEntries, historicalEntries: allEntries });
    });
  });

  ipcMain.handle(IPC.listSkills, () => SKILLS.map(({ id, label, provider, requiredSecrets, requiredParams }) => ({
    id, label, provider, requiredSecrets, requiredParams,
  })));

  ipcMain.handle(IPC.setSecret, async (_e, accountId: string, key: string, value: string) => {
    await secrets.set(accountId, key, value);
  });

  ipcMain.handle(IPC.syncNow, async (_e, accountId: string) => {
    const account = storage.getAccount(accountId);
    if (!account) return { ok: false, error: 'account not found' };
    if (!account.skillId) return { ok: false, error: 'no skill configured' };
    const skill = findSkill(account.skillId);
    if (!skill) return { ok: false, error: `unknown skill: ${account.skillId}` };

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    try {
      const resolvedSecrets = secrets.resolveAll(account.id, skill.requiredSecrets);
      const report = await skill.fetch({ account, secrets: resolvedSecrets });
      // Persist the report as a cumulative entry so it flows through the
      // same calc pipeline as manual entries.
      const entry: UsageEntry = {
        id: randomUUID(),
        accountId: account.id,
        recordedAt: report.retrievedAt,
        value: report.usage.consumed,
        mode: report.usage.mode,
        source: 'skill',
        skillRunId: runId,
      };
      storage.insertEntry(entry);
      storage.recordSkillRun({
        id: runId, accountId: account.id, skillId: skill.id, startedAt,
        finishedAt: new Date().toISOString(), ok: true, reportJson: JSON.stringify(report),
      });
      return { ok: true, report };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      log.error(`syncNow failed for account=${account.id}`, e);
      storage.recordSkillRun({
        id: runId, accountId: account.id, skillId: skill.id, startedAt,
        finishedAt: new Date().toISOString(), ok: false, error: err,
      });
      return { ok: false, error: err };
    }
  });

  ipcMain.handle(IPC.exportData, async (_e, format: 'csv' | 'json'): Promise<string> => {
    const accounts = storage.listAccounts();
    const states = accounts.map((a) => computeAccountState({ account: a, entries: storage.listEntries(a.id) }));
    const entries = accounts.flatMap((a) => storage.listEntries(a.id));

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export data',
      defaultPath: `mister-quota-export-${Date.now()}.${format}`,
      filters: format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return '';

    if (format === 'json') {
      await fs.writeFile(filePath, JSON.stringify({ accounts, entries, states }, null, 2), 'utf8');
    } else {
      const header = ['account_id','account_name','recorded_at','value','mode','source','comment'].join(',');
      const rows = entries.map((e) => [
        e.accountId,
        accounts.find((a) => a.id === e.accountId)?.name ?? '',
        e.recordedAt,
        e.value,
        e.mode,
        e.source,
        (e.comment ?? '').replace(/"/g, '""'),
      ].map((c) => `"${String(c)}"`).join(','));
      // Append a separate per-account state block as commented rows.
      const stateRows = states.map((s) => [
        '#STATE', s.account.id, s.account.name, s.consumed, s.idealToDate,
        s.delta, s.deltaPct.toFixed(2), s.theoreticalDailyAmount.toFixed(2),
        s.requiredDailyAvgRemaining.toFixed(2), s.status,
      ].map((c) => `"${String(c)}"`).join(','));
      await fs.writeFile(filePath, [header, ...rows, '', '#STATE,account_id,name,consumed,idealToDate,delta,deltaPct,theoreticalDailyAmount,requiredDailyAvgRemaining,status', ...stateRows].join('\n'), 'utf8');
    }
    return filePath;
  });
}
