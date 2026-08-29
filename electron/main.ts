import { app, BrowserWindow, ipcMain, dialog, Notification } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Storage } from './db';
import { SecretsStore } from './secrets';
import { Logger } from './log';
import { findSkill, SKILLS } from './skills';
import { computeAccountState } from '../shared/calc';
import { evaluateAlerts } from './alerts';
import { Scheduler } from './scheduler';
import { buildTray, type TrayController } from './tray';
import { setupAutoUpdater } from './updater';
import { IPC } from '../shared/ipc';
import type { Account, AccountState, SkillUsageReport, UsageEntry } from '../shared/types';

// Tiny CSV line parser: handles quoted values with embedded commas and "" escape.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
    } else {
      if (c === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === ',') {
        out.push(cur);
        cur = '';
        i++;
        continue;
      }
      cur += c;
      i++;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const log = new Logger();
const storage = new Storage(log);
const secrets = new SecretsStore();
let mainWindow: BrowserWindow | null = null;
let tray: TrayController | null = null;
let scheduler: Scheduler | null = null;

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
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

async function runSync(
  accountId: string,
): Promise<{ ok: boolean; error?: string; report?: SkillUsageReport }> {
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
      id: runId,
      accountId: account.id,
      skillId: skill.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: true,
      reportJson: JSON.stringify(report),
    });
    // Re-evaluate alerts for this account after the new reading lands.
    const allEntries = storage.listEntries(account.id);
    evaluateAlerts(
      computeAccountState({ account, entries: allEntries, historicalEntries: allEntries }),
      storage,
      log,
    );
    return { ok: true, report };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    log.error(`syncNow failed for account=${account.id}`, e);
    storage.recordSkillRun({
      id: runId,
      accountId: account.id,
      skillId: skill.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: false,
      error: err,
    });
    return { ok: false, error: err };
  }
}

// Re-evaluate alerts for every account whenever computed state changes.
function evaluateAlertsForAll(): void {
  for (const a of storage.listAccounts()) {
    const allEntries = storage.listEntries(a.id);
    const state = computeAccountState({ account: a, entries: allEntries, historicalEntries: allEntries });
    evaluateAlerts(state, storage, log);
  }
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  await log.open(userData);
  log.info(`mister-quota starting; userData=${userData}`);
  await storage.open(userData);
  await secrets.open(userData);

  registerIpcHandlers();

  await createWindow();

  // Tray icon: lets the app live in the background when the main window
  // is closed (useful with scheduled syncs).
  tray = buildTray(
    storage,
    () => mainWindow,
    async () => {
      for (const a of storage.listAccounts()) {
        if (a.skillId) await runSync(a.id);
      }
      tray?.refresh();
    },
  );

  // Scheduler ticks accounts that opted into auto-sync.
  scheduler = new Scheduler(storage, log, async (accountId) => {
    await runSync(accountId);
    tray?.refresh();
  });
  scheduler.reload();

  // Initial alert pass at startup (fires for thresholds already crossed).
  evaluateAlertsForAll();

  // Opt-in auto-updater (env-gated; safe no-op in dev or when not packaged).
  setupAutoUpdater({
    log,
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

// Don't quit when the window closes — the tray keeps the app alive so
// scheduled syncs keep running in the background. Only quit when the
// tray "Quitter" item is invoked.
app.on('window-all-closed', () => {
  /* keep alive */
});

app.on('before-quit', () => {
  scheduler?.stop();
  tray?.destroy();
  storage.close();
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.listAccounts, () => storage.listAccounts());
  ipcMain.handle(IPC.getAccount, (_e, id: string) => storage.getAccount(id));
  ipcMain.handle(IPC.upsertAccount, (_e, a: Account) => {
    storage.upsertAccount(a);
    scheduler?.reload();
    tray?.refresh();
  });
  ipcMain.handle(IPC.deleteAccount, async (_e, id: string) => {
    storage.deleteAccount(id);
    await secrets.deleteForAccount(id);
    scheduler?.reload();
    tray?.refresh();
  });

  ipcMain.handle(IPC.listEntries, (_e, accountId: string) => storage.listEntries(accountId));
  ipcMain.handle(IPC.insertEntry, (_e, entry: UsageEntry) => {
    storage.insertEntry(entry);
    // Re-evaluate alerts after manual entries too.
    const account = storage.getAccount(entry.accountId);
    if (account) {
      const all = storage.listEntries(entry.accountId);
      evaluateAlerts(computeAccountState({ account, entries: all, historicalEntries: all }), storage, log);
    }
    tray?.refresh();
  });
  ipcMain.handle(IPC.deleteEntry, (_e, id: string) => {
    storage.deleteEntry(id);
    tray?.refresh();
  });

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

  ipcMain.handle(IPC.listSkills, () =>
    SKILLS.map(({ id, label, provider, requiredSecrets, requiredParams }) => ({
      id,
      label,
      provider,
      requiredSecrets,
      requiredParams,
    })),
  );

  ipcMain.handle(IPC.setSecret, async (_e, accountId: string, key: string, value: string) => {
    await secrets.set(accountId, key, value);
  });

  ipcMain.handle(IPC.syncNow, (_e, accountId: string) => runSync(accountId));

  ipcMain.handle(IPC.listSkillRuns, (_e, opts: { accountId?: string; limit?: number } = {}) =>
    storage.listSkillRuns(opts),
  );

  ipcMain.handle(
    IPC.importEntriesCsv,
    (_e, accountId: string, csvText: string): { inserted: number; errors: string[] } => {
      const account = storage.getAccount(accountId);
      if (!account) return { inserted: 0, errors: ['account not found'] };
      const errors: string[] = [];
      let inserted = 0;
      const lines = csvText.split(/\r?\n/);
      // Heuristic header detection — look for known field names.
      const headerIdx = lines.findIndex((l) => /recorded_?at|date|timestamp/i.test(l));
      let dateCol = 0,
        valueCol = 1,
        modeCol = 2,
        commentCol = 3;
      if (headerIdx >= 0) {
        const cols = parseCsvLine(lines[headerIdx]);
        const idx = (re: RegExp) => cols.findIndex((c) => re.test(c));
        dateCol = idx(/recorded_?at|date|timestamp/i);
        valueCol = idx(/value|consumed|amount|tokens/i);
        modeCol = idx(/mode/i);
        commentCol = idx(/comment|note/i);
      }
      for (let i = headerIdx >= 0 ? headerIdx + 1 : 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        const cols = parseCsvLine(line);
        try {
          const recordedAt = new Date(cols[dateCol]);
          if (Number.isNaN(recordedAt.getTime())) throw new Error(`invalid date: ${cols[dateCol]}`);
          const value = Number(cols[valueCol]);
          if (!Number.isFinite(value)) throw new Error(`invalid value: ${cols[valueCol]}`);
          const modeRaw = (modeCol >= 0 ? cols[modeCol] : 'cumulative').toLowerCase();
          const mode = modeRaw === 'delta' ? 'delta' : 'cumulative';
          storage.insertEntry({
            id: randomUUID(),
            accountId,
            recordedAt: recordedAt.toISOString(),
            value,
            mode,
            source: 'manual',
            comment: commentCol >= 0 ? cols[commentCol] : undefined,
          });
          inserted++;
        } catch (err) {
          errors.push(`L${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { inserted, errors };
    },
  );

  ipcMain.handle(IPC.exportData, async (_e, format: 'csv' | 'json'): Promise<string> => {
    const accounts = storage.listAccounts();
    const states = accounts.map((a) =>
      computeAccountState({ account: a, entries: storage.listEntries(a.id) }),
    );
    const entries = accounts.flatMap((a) => storage.listEntries(a.id));

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export data',
      defaultPath: `mister-quota-export-${Date.now()}.${format}`,
      filters:
        format === 'csv' ? [{ name: 'CSV', extensions: ['csv'] }] : [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return '';

    if (format === 'json') {
      await fs.writeFile(filePath, JSON.stringify({ accounts, entries, states }, null, 2), 'utf8');
    } else {
      const header = ['account_id', 'account_name', 'recorded_at', 'value', 'mode', 'source', 'comment'].join(
        ',',
      );
      const rows = entries.map((e) =>
        [
          e.accountId,
          accounts.find((a) => a.id === e.accountId)?.name ?? '',
          e.recordedAt,
          e.value,
          e.mode,
          e.source,
          (e.comment ?? '').replace(/"/g, '""'),
        ]
          .map((c) => `"${String(c)}"`)
          .join(','),
      );
      // Append a separate per-account state block as commented rows.
      const stateRows = states.map((s) =>
        [
          '#STATE',
          s.account.id,
          s.account.name,
          s.consumed,
          s.idealToDate,
          s.delta,
          s.deltaPct.toFixed(2),
          s.theoreticalDailyAmount.toFixed(2),
          s.requiredDailyAvgRemaining.toFixed(2),
          s.status,
        ]
          .map((c) => `"${String(c)}"`)
          .join(','),
      );
      await fs.writeFile(
        filePath,
        [
          header,
          ...rows,
          '',
          '#STATE,account_id,name,consumed,idealToDate,delta,deltaPct,theoreticalDailyAmount,requiredDailyAvgRemaining,status',
          ...stateRows,
        ].join('\n'),
        'utf8',
      );
    }
    return filePath;
  });
}
