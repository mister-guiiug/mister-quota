// Integration tests for the Storage layer. We can't import electron's
// safeStorage from a Node test, so this file only exercises Storage (which
// is electron-free) — SecretsStore lives in its own file and is covered
// elsewhere.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Storage } from './db';
import type { Account, UsageEntry } from '../shared/types';

const silent = { info: () => {}, error: () => {} };

function mkAccount(over: Partial<Account> = {}): Account {
  return {
    id: over.id ?? 'a1',
    name: over.name ?? 'Cursor Max',
    provider: over.provider ?? 'cursor',
    periodRule: { type: 'monthly', dayOfMonth: 1, timezone: 'Europe/Paris' },
    quota: over.quota ?? 500_000_000,
    unit: over.unit ?? 'tokens',
    collection: over.collection ?? 'manual',
    tolerancePct: over.tolerancePct ?? 3,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...over,
  };
}

function mkEntry(over: Partial<UsageEntry> = {}): UsageEntry {
  return {
    id: over.id ?? crypto.randomUUID(),
    accountId: over.accountId ?? 'a1',
    recordedAt: over.recordedAt ?? '2026-05-10T12:00:00Z',
    value: over.value ?? 100,
    mode: over.mode ?? 'cumulative',
    source: over.source ?? 'manual',
    ...over,
  };
}

let dir: string;
let storage: Storage;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'mq-test-'));
  storage = new Storage(silent);
  await storage.open(dir);
});

afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Storage — accounts', () => {
  it('round-trips an account through upsert/get/list', () => {
    const a = mkAccount();
    storage.upsertAccount(a);
    expect(storage.getAccount(a.id)).toMatchObject({ id: 'a1', name: 'Cursor Max' });
    expect(storage.listAccounts()).toHaveLength(1);
  });

  it('updates an existing account on upsert (same id)', () => {
    storage.upsertAccount(mkAccount({ name: 'v1' }));
    storage.upsertAccount(mkAccount({ name: 'v2' }));
    expect(storage.getAccount('a1')?.name).toBe('v2');
    expect(storage.listAccounts()).toHaveLength(1);
  });

  it('cascades entry deletion when account is removed', () => {
    storage.upsertAccount(mkAccount());
    storage.insertEntry(mkEntry());
    storage.insertEntry(mkEntry({ id: 'e2' }));
    expect(storage.listEntries('a1')).toHaveLength(2);
    storage.deleteAccount('a1');
    expect(storage.listEntries('a1')).toHaveLength(0);
    expect(storage.listAccounts()).toHaveLength(0);
  });
});

describe('Storage — entries', () => {
  beforeEach(() => storage.upsertAccount(mkAccount()));

  it('lists entries newest first', () => {
    storage.insertEntry(mkEntry({ id: 'e1', recordedAt: '2026-05-10T00:00:00Z' }));
    storage.insertEntry(mkEntry({ id: 'e2', recordedAt: '2026-05-12T00:00:00Z' }));
    storage.insertEntry(mkEntry({ id: 'e3', recordedAt: '2026-05-11T00:00:00Z' }));
    const ids = storage.listEntries('a1').map((e) => e.id);
    expect(ids).toEqual(['e2', 'e3', 'e1']);
  });

  it('deletes a single entry without affecting siblings', () => {
    storage.insertEntry(mkEntry({ id: 'e1' }));
    storage.insertEntry(mkEntry({ id: 'e2' }));
    storage.deleteEntry('e1');
    expect(storage.listEntries('a1').map((e) => e.id)).toEqual(['e2']);
  });
});

describe('Storage — skill runs', () => {
  beforeEach(() => storage.upsertAccount(mkAccount()));

  it('persists ok and error runs', () => {
    storage.recordSkillRun({ id: 'r1', accountId: 'a1', skillId: 'cursor', startedAt: '2026-05-10T00:00:00Z', finishedAt: '2026-05-10T00:00:01Z', ok: true, reportJson: '{}' });
    storage.recordSkillRun({ id: 'r2', accountId: 'a1', skillId: 'cursor', startedAt: '2026-05-10T00:00:02Z', finishedAt: '2026-05-10T00:00:03Z', ok: false, error: 'boom' });
    const runs = storage.listSkillRuns({ limit: 10 });
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe('r2'); // newest first
    expect(runs.find((r) => r.id === 'r2')?.ok).toBe(false);
    expect(runs.find((r) => r.id === 'r2')?.error).toBe('boom');
  });

  it('filters runs by account', () => {
    storage.upsertAccount(mkAccount({ id: 'a2', name: 'Other' }));
    storage.recordSkillRun({ id: 'r1', accountId: 'a1', skillId: 'cursor', startedAt: 'x', ok: true });
    storage.recordSkillRun({ id: 'r2', accountId: 'a2', skillId: 'cursor', startedAt: 'x', ok: true });
    expect(storage.listSkillRuns({ accountId: 'a1' })).toHaveLength(1);
    expect(storage.listSkillRuns({ accountId: 'a2' })).toHaveLength(1);
  });
});

describe('Storage — persistence', () => {
  it('survives a close-and-reopen cycle (data flushed to disk)', async () => {
    storage.upsertAccount(mkAccount({ name: 'persisted' }));
    storage.insertEntry(mkEntry({ id: 'e1', value: 42 }));
    storage.close();

    const reopened = new Storage(silent);
    await reopened.open(dir);
    expect(reopened.getAccount('a1')?.name).toBe('persisted');
    expect(reopened.listEntries('a1')).toHaveLength(1);
    expect(reopened.listEntries('a1')[0].value).toBe(42);
    reopened.close();
  });

  it('runs migrations idempotently across reopens', async () => {
    storage.close();
    const r1 = new Storage(silent);
    await r1.open(dir);
    r1.upsertAccount(mkAccount());
    r1.close();
    // Reopen — should not re-run migrations or duplicate data
    const r2 = new Storage(silent);
    await r2.open(dir);
    expect(r2.listAccounts()).toHaveLength(1);
    r2.close();
  });
});
