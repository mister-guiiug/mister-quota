// SQLite storage backed by sql.js (pure-WASM SQLite). The DB file lives in
// app.getPath('userData')/mister-quota.sqlite and is flushed to disk after
// every write operation. Migrations are forward-only and idempotent.

import { promises as fs, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

// Resolve sql-wasm.wasm in a way that works under both Node CommonJS (Electron
// main, compiled by tsc) and Vite/Vitest ESM contexts. The file *must* be
// findable on disk for sql.js to mmap it.
function resolveWasmPath(): string {
  const candidates: string[] = [];
  // CWD-based first (deterministic in tests and Electron when started from project root).
  candidates.push(path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'));
  // Then walk up from this file's location to support packaged Electron layouts
  // where cwd is the install dir, not the source tree.
  if (typeof __dirname !== 'undefined') {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(dir, 'node_modules/sql.js/dist/sql-wasm.wasm'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const p of candidates) if (existsSync(p)) return p;
  throw new Error(`sql-wasm.wasm not found in: ${candidates.join(', ')}`);
}
import type { Account, UsageEntry } from '../shared/types';

interface Logger {
  info: (msg: string) => void;
  error: (msg: string, err?: unknown) => void;
}

export interface SkillRunRow {
  id: string;
  accountId: string;
  skillId: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  error?: string;
  reportJson?: string;
}

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        period_rule_json TEXT NOT NULL,
        quota REAL NOT NULL,
        unit TEXT NOT NULL,
        currency TEXT,
        collection TEXT NOT NULL,
        skill_id TEXT,
        skill_params_json TEXT,
        tolerance_pct REAL NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        recorded_at TEXT NOT NULL,
        value REAL NOT NULL,
        mode TEXT NOT NULL,
        source TEXT NOT NULL,
        comment TEXT,
        skill_run_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_account_recorded
        ON entries(account_id, recorded_at);
      CREATE TABLE IF NOT EXISTS skill_runs (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        skill_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        ok INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        report_json TEXT
      );
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE accounts ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE accounts ADD COLUMN sync_interval_minutes INTEGER;
      ALTER TABLE accounts ADD COLUMN alert_thresholds_json TEXT NOT NULL DEFAULT '[80,100]';
      ALTER TABLE accounts ADD COLUMN last_alerted_threshold_pct REAL;
      ALTER TABLE accounts ADD COLUMN last_alert_period_start TEXT;
    `,
  },
];

// Version de schéma qu'une base fraîchement migrée porte. C'est elle que
// l'export inscrit dans la sauvegarde et que l'import compare, pour refuser
// proprement un fichier écrit par une version future de l'application.
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class Storage {
  private db!: Database;
  private dbPath!: string;
  private SQL!: SqlJsStatic;
  private log: Logger;
  private closed = false;

  constructor(log: Logger) {
    this.log = log;
  }

  async open(userDataDir: string): Promise<void> {
    this.dbPath = path.join(userDataDir, 'mister-quota.sqlite');
    const wasmPath = resolveWasmPath();
    const wasmDir = path.dirname(wasmPath);
    this.SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) });

    let buffer: Buffer | null = null;
    try {
      buffer = await fs.readFile(this.dbPath);
    } catch {
      buffer = null;
    }
    this.db = buffer ? new this.SQL.Database(new Uint8Array(buffer)) : new this.SQL.Database();
    this.migrate();
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);');
    const res = this.db.exec('SELECT MAX(version) as v FROM schema_version');
    const current = (res[0]?.values?.[0]?.[0] as number | null) ?? 0;
    for (const m of MIGRATIONS) {
      if (m.version > current) {
        this.log.info(`Applying migration v${m.version}`);
        this.db.exec('BEGIN');
        try {
          this.db.exec(m.sql);
          this.db.run('INSERT INTO schema_version(version) VALUES (?)', [m.version]);
          this.db.exec('COMMIT');
        } catch (e) {
          this.db.exec('ROLLBACK');
          throw e;
        }
      }
    }
    this.flush();
  }

  private flush(): void {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
    // sql.js's db.export() resets per-connection PRAGMAs (it serializes via
    // a transient internal connection). Re-arm foreign-key enforcement so
    // ON DELETE CASCADE keeps working after every write.
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  // Version réellement inscrite dans la base ouverte (et non celle du code) :
  // c'est ce que la sauvegarde doit déclarer.
  schemaVersion(): number {
    const res = this.db.exec('SELECT MAX(version) as v FROM schema_version');
    return (res[0]?.values?.[0]?.[0] as number | null) ?? 0;
  }

  counts(): { accounts: number; entries: number; skillRuns: number } {
    const one = (sql: string): number => {
      const res = this.db.exec(sql);
      return (res[0]?.values?.[0]?.[0] as number | null) ?? 0;
    };
    return {
      accounts: one('SELECT COUNT(*) FROM accounts'),
      entries: one('SELECT COUNT(*) FROM entries'),
      skillRuns: one('SELECT COUNT(*) FROM skill_runs'),
    };
  }

  // ── Accounts ──────────────────────────────────────────────────────────────
  listAccounts(): Account[] {
    const res = this.db.exec('SELECT * FROM accounts ORDER BY name COLLATE NOCASE');
    if (!res[0]) return [];
    return res[0].values.map((row) => rowToAccount(res[0].columns, row));
  }

  getAccount(id: string): Account | null {
    const stmt = this.db.prepare('SELECT * FROM accounts WHERE id = ?');
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const obj = stmt.getAsObject();
    stmt.free();
    return rowObjToAccount(obj);
  }

  upsertAccount(a: Account): void {
    this.upsertAccountRow(a);
    this.flush();
  }

  // Écriture SANS vidage disque : `flush()` sérialise toute la base, ce qui est
  // à la fois coûteux et interdit au milieu d'une transaction. Les restaurations
  // (`replaceAll`) écrivent des centaines de lignes puis vident une seule fois.
  private upsertAccountRow(a: Account): void {
    this.db.run(
      `INSERT INTO accounts(
         id,name,provider,period_rule_json,quota,unit,currency,collection,
         skill_id,skill_params_json,tolerance_pct,
         tags_json,sync_interval_minutes,alert_thresholds_json,
         last_alerted_threshold_pct,last_alert_period_start,
         created_at,updated_at
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name,
         provider=excluded.provider,
         period_rule_json=excluded.period_rule_json,
         quota=excluded.quota,
         unit=excluded.unit,
         currency=excluded.currency,
         collection=excluded.collection,
         skill_id=excluded.skill_id,
         skill_params_json=excluded.skill_params_json,
         tolerance_pct=excluded.tolerance_pct,
         tags_json=excluded.tags_json,
         sync_interval_minutes=excluded.sync_interval_minutes,
         alert_thresholds_json=excluded.alert_thresholds_json,
         last_alerted_threshold_pct=excluded.last_alerted_threshold_pct,
         last_alert_period_start=excluded.last_alert_period_start,
         updated_at=excluded.updated_at`,
      [
        a.id,
        a.name,
        a.provider,
        JSON.stringify(a.periodRule),
        a.quota,
        a.unit,
        a.currency ?? null,
        a.collection,
        a.skillId ?? null,
        a.skillParams ? JSON.stringify(a.skillParams) : null,
        a.tolerancePct,
        JSON.stringify(a.tags ?? []),
        a.syncIntervalMinutes ?? null,
        JSON.stringify(a.alertThresholdsPct ?? [80, 100]),
        a.lastAlertedThresholdPct ?? null,
        a.lastAlertPeriodStart ?? null,
        a.createdAt,
        a.updatedAt,
      ],
    );
  }

  deleteAccount(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
    this.flush();
  }

  // ── Entries ───────────────────────────────────────────────────────────────
  listEntries(accountId: string): UsageEntry[] {
    const stmt = this.db.prepare('SELECT * FROM entries WHERE account_id = ? ORDER BY recorded_at DESC');
    stmt.bind([accountId]);
    const out: UsageEntry[] = [];
    while (stmt.step()) out.push(rowObjToEntry(stmt.getAsObject()));
    stmt.free();
    return out;
  }

  insertEntry(e: UsageEntry): void {
    this.insertEntryRow(e);
    this.flush();
  }

  private insertEntryRow(e: UsageEntry): void {
    this.db.run(
      `INSERT INTO entries(id,account_id,recorded_at,value,mode,source,comment,skill_run_id)
       VALUES(?,?,?,?,?,?,?,?)`,
      [e.id, e.accountId, e.recordedAt, e.value, e.mode, e.source, e.comment ?? null, e.skillRunId ?? null],
    );
  }

  deleteEntry(id: string): void {
    this.db.run('DELETE FROM entries WHERE id = ?', [id]);
    this.flush();
  }

  // ── Skill runs (audit log) ───────────────────────────────────────────────
  recordSkillRun(run: {
    id: string;
    accountId: string;
    skillId: string;
    startedAt: string;
    finishedAt?: string;
    ok: boolean;
    error?: string;
    reportJson?: string;
  }): void {
    this.db.run(
      `INSERT INTO skill_runs(id,account_id,skill_id,started_at,finished_at,ok,error,report_json)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        run.id,
        run.accountId,
        run.skillId,
        run.startedAt,
        run.finishedAt ?? null,
        run.ok ? 1 : 0,
        run.error ?? null,
        run.reportJson ?? null,
      ],
    );
    this.flush();
  }

  listSkillRuns(opts: { accountId?: string; limit?: number } = {}): SkillRunRow[] {
    const limit = opts.limit ?? 200;
    const sql = opts.accountId
      ? 'SELECT * FROM skill_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?'
      : 'SELECT * FROM skill_runs ORDER BY started_at DESC LIMIT ?';
    const stmt = this.db.prepare(sql);
    stmt.bind(opts.accountId ? [opts.accountId, limit] : [limit]);
    const out: SkillRunRow[] = [];
    while (stmt.step()) {
      const o = stmt.getAsObject();
      out.push({
        id: o.id as string,
        accountId: o.account_id as string,
        skillId: o.skill_id as string,
        startedAt: o.started_at as string,
        finishedAt: (o.finished_at as string) ?? undefined,
        ok: (o.ok as number) === 1,
        error: (o.error as string) ?? undefined,
        reportJson: (o.report_json as string) ?? undefined,
      });
    }
    stmt.free();
    return out;
  }

  // ── Restauration ─────────────────────────────────────────────────────────
  // Remplace intégralement le contenu par celui d'une sauvegarde déjà VALIDÉE
  // (`shared/backup.ts` : validation d'abord, écriture ensuite — un fichier
  // étranger n'arrive jamais jusqu'ici et n'efface donc rien).
  //
  // Tout tient dans une transaction : une contrainte violée à la 200e ligne
  // laisserait sinon une base à moitié écrasée, c'est-à-dire pire que l'état
  // d'avant. Le vidage disque n'a lieu qu'après le COMMIT.
  //
  // `skill_runs` disparaît : l'audit des exécutions décrit CETTE installation,
  // pas les données restaurées, et sa clé étrangère pointe sur des comptes qui
  // s'en vont. L'interface le dit avant de confirmer.
  //
  // Les secrets ne sont pas concernés : ils ne sont pas dans le fichier et ce
  // module n'y touche pas.
  replaceAll(data: { accounts: Account[]; entries: UsageEntry[] }): {
    accounts: number;
    entries: number;
  } {
    this.db.exec('BEGIN');
    try {
      this.db.run('DELETE FROM skill_runs');
      this.db.run('DELETE FROM entries');
      this.db.run('DELETE FROM accounts');
      for (const a of data.accounts) this.upsertAccountRow(a);
      for (const e of data.entries) this.insertEntryRow(e);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.log.error('replaceAll failed — base laissée intacte', e);
      throw e;
    }
    this.flush();
    return { accounts: data.accounts.length, entries: data.entries.length };
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}

// ── row → object helpers (sql.js returns string column lists + value arrays) ──

function rowToAccount(columns: string[], row: any[]): Account {
  const obj: Record<string, any> = {};
  columns.forEach((c, i) => {
    obj[c] = row[i];
  });
  return rowObjToAccount(obj);
}

function rowObjToAccount(o: Record<string, any>): Account {
  return {
    id: o.id,
    name: o.name,
    provider: o.provider,
    periodRule: JSON.parse(o.period_rule_json),
    quota: o.quota,
    unit: o.unit,
    currency: o.currency ?? undefined,
    collection: o.collection,
    skillId: o.skill_id ?? undefined,
    skillParams: o.skill_params_json ? JSON.parse(o.skill_params_json) : undefined,
    tolerancePct: o.tolerance_pct,
    tags: o.tags_json ? JSON.parse(o.tags_json) : [],
    syncIntervalMinutes: o.sync_interval_minutes ?? undefined,
    alertThresholdsPct: o.alert_thresholds_json ? JSON.parse(o.alert_thresholds_json) : [80, 100],
    lastAlertedThresholdPct: o.last_alerted_threshold_pct ?? undefined,
    lastAlertPeriodStart: o.last_alert_period_start ?? undefined,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function rowObjToEntry(o: Record<string, any>): UsageEntry {
  return {
    id: o.id,
    accountId: o.account_id,
    recordedAt: o.recorded_at,
    value: o.value,
    mode: o.mode,
    source: o.source,
    comment: o.comment ?? undefined,
    skillRunId: o.skill_run_id ?? undefined,
  };
}
