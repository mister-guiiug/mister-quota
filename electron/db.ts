// SQLite storage backed by sql.js (pure-WASM SQLite). The DB file lives in
// app.getPath('userData')/mister-quota.sqlite and is flushed to disk after
// every write operation. Migrations are forward-only and idempotent.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { Account, UsageEntry } from '../shared/types';

interface Logger { info: (msg: string) => void; error: (msg: string, err?: unknown) => void }

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
];

export class Storage {
  private db!: Database;
  private dbPath!: string;
  private SQL!: SqlJsStatic;
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async open(userDataDir: string): Promise<void> {
    this.dbPath = path.join(userDataDir, 'mister-quota.sqlite');
    // sql.js needs the wasm file; resolve it from node_modules so packaging picks it up.
    const wasmDir = path.join(require.resolve('sql.js/dist/sql-wasm.wasm'), '..');
    this.SQL = await initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) });

    let buffer: Buffer | null = null;
    try {
      buffer = await fs.readFile(this.dbPath);
    } catch {
      buffer = null;
    }
    this.db = buffer ? new this.SQL.Database(new Uint8Array(buffer)) : new this.SQL.Database();
    this.migrate();
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
    // Write synchronously enough — fs.writeFileSync via fs/promises wrapper.
    require('node:fs').writeFileSync(this.dbPath, Buffer.from(data));
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
    if (!stmt.step()) { stmt.free(); return null; }
    const obj = stmt.getAsObject();
    stmt.free();
    return rowObjToAccount(obj);
  }

  upsertAccount(a: Account): void {
    this.db.run(
      `INSERT INTO accounts(id,name,provider,period_rule_json,quota,unit,currency,collection,skill_id,skill_params_json,tolerance_pct,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
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
         updated_at=excluded.updated_at`,
      [
        a.id, a.name, a.provider, JSON.stringify(a.periodRule), a.quota, a.unit,
        a.currency ?? null, a.collection, a.skillId ?? null,
        a.skillParams ? JSON.stringify(a.skillParams) : null,
        a.tolerancePct, a.createdAt, a.updatedAt,
      ],
    );
    this.flush();
  }

  deleteAccount(id: string): void {
    this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
    this.flush();
  }

  // ── Entries ───────────────────────────────────────────────────────────────
  listEntries(accountId: string): UsageEntry[] {
    const stmt = this.db.prepare(
      'SELECT * FROM entries WHERE account_id = ? ORDER BY recorded_at DESC',
    );
    stmt.bind([accountId]);
    const out: UsageEntry[] = [];
    while (stmt.step()) out.push(rowObjToEntry(stmt.getAsObject()));
    stmt.free();
    return out;
  }

  insertEntry(e: UsageEntry): void {
    this.db.run(
      `INSERT INTO entries(id,account_id,recorded_at,value,mode,source,comment,skill_run_id)
       VALUES(?,?,?,?,?,?,?,?)`,
      [e.id, e.accountId, e.recordedAt, e.value, e.mode, e.source, e.comment ?? null, e.skillRunId ?? null],
    );
    this.flush();
  }

  deleteEntry(id: string): void {
    this.db.run('DELETE FROM entries WHERE id = ?', [id]);
    this.flush();
  }

  // ── Skill runs (audit log) ───────────────────────────────────────────────
  recordSkillRun(run: { id: string; accountId: string; skillId: string; startedAt: string; finishedAt?: string; ok: boolean; error?: string; reportJson?: string }): void {
    this.db.run(
      `INSERT INTO skill_runs(id,account_id,skill_id,started_at,finished_at,ok,error,report_json)
       VALUES(?,?,?,?,?,?,?,?)`,
      [run.id, run.accountId, run.skillId, run.startedAt, run.finishedAt ?? null, run.ok ? 1 : 0, run.error ?? null, run.reportJson ?? null],
    );
    this.flush();
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

// ── row → object helpers (sql.js returns string column lists + value arrays) ──

function rowToAccount(columns: string[], row: any[]): Account {
  const obj: Record<string, any> = {};
  columns.forEach((c, i) => { obj[c] = row[i]; });
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
