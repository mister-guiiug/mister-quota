// Format de sauvegarde — construction et VALIDATION, sans dépendance ni accès
// disque (comme tout ce qui vit dans `shared/`).
//
// Pourquoi un module à part : l'export JSON existait déjà, mais rien ne savait
// le relire. Un vidage sans restauration n'est pas une sauvegarde. Trois
// propriétés sont exigées ici et vérifiées par les tests :
//
//  1. le fichier se déclare (`app`, `formatVersion`, `schemaVersion`), donc un
//     fichier venu d'une autre application est REFUSÉ avant toute écriture ;
//  2. la version de schéma de la base (`electron/db.ts`) est respectée : une
//     version inconnue est refusée proprement, une version plus ancienne est
//     complétée avec les défauts de la migration correspondante ;
//  3. les comptes et relevés sont RECONSTRUITS champ par champ à partir d'une
//     liste blanche. Tout ce que le fichier contient en plus — au premier chef
//     une clé d'API glissée à la main — est jeté et n'atteint jamais la base.
//     Les secrets vivent dans le trousseau de l'OS (`electron/secrets.ts`) ;
//     ni l'export ni l'import ne les touchent.

import type {
  Account,
  AccountState,
  CollectionMethod,
  EntryMode,
  EntrySource,
  PeriodRule,
  PeriodType,
  Provider,
  Unit,
  UsageEntry,
} from './types';

export const BACKUP_APP_ID = 'mister-quota';
export const BACKUP_FORMAT_VERSION = 1;

// Version du schéma SQLite que ce format sait relire. Elle DOIT suivre la
// dernière migration de `electron/db.ts` ; `electron/db.test.ts` verrouille
// l'égalité, de sorte qu'une migration v3 ajoutée sans passer ici fasse tomber
// la suite plutôt que de produire des sauvegardes mal étiquetées. Le renderer
// en a besoin aussi (le shim d'aperçu valide les fichiers comme le fait le
// processus principal) et ne peut pas importer `electron/db.ts`, qui tire
// sql.js derrière lui.
export const DB_SCHEMA_VERSION = 2;

export interface BackupFile {
  app: string;
  formatVersion: number;
  schemaVersion: number; // version du schéma SQLite (schema_version)
  exportedAt: string;
  accounts: Account[];
  entries: UsageEntry[];
  // Purement informatif (lisible par un humain, ignoré à l'import) : les états
  // calculés sont dérivés des comptes et des relevés.
  states?: AccountState[];
}

export interface ParsedBackup {
  schemaVersion: number;
  exportedAt: string;
  accounts: Account[];
  entries: UsageEntry[];
}

export type ParseBackupResult = { ok: true; backup: ParsedBackup } | { ok: false; error: string };

const PROVIDERS: readonly Provider[] = ['cursor', 'claude', 'openai', 'other'];
const UNITS: readonly Unit[] = ['tokens', 'credits', 'requests', 'currency'];
const COLLECTIONS: readonly CollectionMethod[] = ['manual', 'auto', 'hybrid'];
const PERIOD_TYPES: readonly PeriodType[] = ['weekly', 'monthly', 'yearly', 'custom'];
const ENTRY_MODES: readonly EntryMode[] = ['cumulative', 'delta'];
const ENTRY_SOURCES: readonly EntrySource[] = ['manual', 'skill'];

// Les deux projections ci-dessous sont la contrepartie EXPORT de la liste
// blanche d'import : le fichier ne contient que les champs nommés ici, quoi
// qu'on ait posé sur l'objet en mémoire. C'est ce qui garantit qu'une clé d'API
// ne peut pas fuir par accident — elle vit dans le trousseau de l'OS
// (`electron/secrets.ts`), qui n'est jamais lu par ce module, et même une
// pollution d'objet ne la ferait pas sortir. `electron/backup-secrets.test.ts`
// le prouve.
function exportedAccount(a: Account): Account {
  return {
    id: a.id,
    name: a.name,
    provider: a.provider,
    periodRule: { ...a.periodRule },
    quota: a.quota,
    unit: a.unit,
    ...(a.currency !== undefined ? { currency: a.currency } : {}),
    collection: a.collection,
    ...(a.skillId !== undefined ? { skillId: a.skillId } : {}),
    // Paramètres NON secrets du connecteur (identifiant d'organisation, de
    // projet…). C'est le seul champ libre d'un compte, d'où le filtrage à des
    // valeurs primitives des deux côtés du voyage.
    ...(a.skillParams !== undefined ? { skillParams: publicParams(a.skillParams) } : {}),
    tolerancePct: a.tolerancePct,
    tags: [...(a.tags ?? [])],
    ...(a.syncIntervalMinutes !== undefined ? { syncIntervalMinutes: a.syncIntervalMinutes } : {}),
    alertThresholdsPct: [...(a.alertThresholdsPct ?? [])],
    ...(a.lastAlertedThresholdPct !== undefined
      ? { lastAlertedThresholdPct: a.lastAlertedThresholdPct }
      : {}),
    ...(a.lastAlertPeriodStart !== undefined ? { lastAlertPeriodStart: a.lastAlertPeriodStart } : {}),
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

function exportedEntry(e: UsageEntry): UsageEntry {
  return {
    id: e.id,
    accountId: e.accountId,
    recordedAt: e.recordedAt,
    value: e.value,
    mode: e.mode,
    source: e.source,
    ...(e.comment !== undefined ? { comment: e.comment } : {}),
    ...(e.skillRunId !== undefined ? { skillRunId: e.skillRunId } : {}),
  };
}

function publicParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function buildBackup(input: {
  accounts: Account[];
  entries: UsageEntry[];
  schemaVersion: number;
  exportedAt?: string;
  states?: AccountState[];
}): BackupFile {
  return {
    app: BACKUP_APP_ID,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: input.schemaVersion,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    accounts: input.accounts.map(exportedAccount),
    entries: input.entries.map(exportedEntry),
    ...(input.states
      ? { states: input.states.map((s) => ({ ...s, account: exportedAccount(s.account) })) }
      : {}),
  };
}

// ── Export CSV ───────────────────────────────────────────────────────────────
// Le CSV est un VIDAGE lisible (tableur), pas une sauvegarde : il perd les
// règles de période, les seuils, les tags, et l'app ne sait pas le relire au
// delà des relevés d'un compte (`importEntriesCsv`). Il est construit ici pour
// la même raison que le JSON : une seule liste de colonnes, testable, qui ne
// peut pas contenir de secret.
function csvCell(value: unknown): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export const EXPORT_CSV_HEADER = [
  'account_id',
  'account_name',
  'recorded_at',
  'value',
  'mode',
  'source',
  'comment',
] as const;

export function buildExportCsv(input: {
  accounts: Account[];
  entries: UsageEntry[];
  states: AccountState[];
}): string {
  const nameOf = (id: string): string => input.accounts.find((a) => a.id === id)?.name ?? '';
  const rows = input.entries.map((e) =>
    [e.accountId, nameOf(e.accountId), e.recordedAt, e.value, e.mode, e.source, e.comment ?? '']
      .map(csvCell)
      .join(','),
  );
  const stateRows = input.states.map((s) =>
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
      .map(csvCell)
      .join(','),
  );
  return [
    EXPORT_CSV_HEADER.join(','),
    ...rows,
    '',
    '#STATE,account_id,name,consumed,idealToDate,delta,deltaPct,theoreticalDailyAmount,requiredDailyAvgRemaining,status',
    ...stateRows,
  ].join('\n');
}

// ── Validation ───────────────────────────────────────────────────────────────
// Les messages d'erreur nomment le champ fautif et JAMAIS son contenu : un
// fichier étranger ne doit pas voir son texte réaffiché dans l'interface.

class SchemaError extends Error {}

function fail(message: string): never {
  throw new SchemaError(message);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) fail(`${where} : champ « ${key} » attendu (texte non vide)`);
  return v;
}

function optionalStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where} : champ « ${key} » attendu (nombre)`);
  return v;
}

function optionalNum(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function oneOf<T extends string>(
  o: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  where: string,
): T {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    fail(`${where} : champ « ${key} » hors des valeurs admises (${allowed.join(', ')})`);
  }
  return v as T;
}

function parsePeriodRule(value: unknown, where: string): PeriodRule {
  if (!isRecord(value)) fail(`${where} : champ « periodRule » attendu (objet)`);
  const rule: PeriodRule = {
    type: oneOf(value, 'type', PERIOD_TYPES, `${where} · periodRule`),
    timezone: str(value, 'timezone', `${where} · periodRule`),
  };
  const weekday = optionalNum(value, 'weekday');
  if (weekday !== undefined && weekday >= 1 && weekday <= 7) {
    rule.weekday = weekday as PeriodRule['weekday'];
  }
  const dayOfMonth = optionalNum(value, 'dayOfMonth');
  if (dayOfMonth !== undefined) rule.dayOfMonth = dayOfMonth;
  const month = optionalNum(value, 'month');
  if (month !== undefined) rule.month = month;
  const day = optionalNum(value, 'day');
  if (day !== undefined) rule.day = day;
  const startDate = optionalStr(value, 'startDate');
  if (startDate !== undefined) rule.startDate = startDate;
  const periodLengthDays = optionalNum(value, 'periodLengthDays');
  if (periodLengthDays !== undefined) rule.periodLengthDays = periodLengthDays;
  return rule;
}

// `skillParams` est le SEUL champ libre d'un compte. Par contrat il ne contient
// que des paramètres non sensibles (`Skill.requiredParams` : identifiant
// d'organisation, de projet…) : on n'accepte donc qu'un objet plat de valeurs
// primitives, jamais une structure imbriquée.
function parseSkillParams(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAccount(value: unknown, index: number): Account {
  const where = `compte n° ${index + 1}`;
  if (!isRecord(value)) fail(`${where} : objet attendu`);

  // Reconstruction par liste blanche : ce qui n'est pas listé ici n'entre pas
  // dans la base, quoi que contienne le fichier.
  const account: Account = {
    id: str(value, 'id', where),
    name: str(value, 'name', where),
    provider: oneOf(value, 'provider', PROVIDERS, where),
    periodRule: parsePeriodRule(value.periodRule, where),
    quota: num(value, 'quota', where),
    unit: oneOf(value, 'unit', UNITS, where),
    collection: oneOf(value, 'collection', COLLECTIONS, where),
    tolerancePct: optionalNum(value, 'tolerancePct') ?? 3,
    // Colonnes apparues avec la migration v2 : absentes d'une sauvegarde v1, on
    // reprend exactement les défauts de la migration.
    tags: Array.isArray(value.tags) ? value.tags.filter((t): t is string => typeof t === 'string') : [],
    alertThresholdsPct: Array.isArray(value.alertThresholdsPct)
      ? value.alertThresholdsPct.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
      : [80, 100],
    createdAt: str(value, 'createdAt', where),
    updatedAt: str(value, 'updatedAt', where),
  };

  const currency = optionalStr(value, 'currency');
  if (currency !== undefined) account.currency = currency;
  const skillId = optionalStr(value, 'skillId');
  if (skillId !== undefined) account.skillId = skillId;
  const skillParams = parseSkillParams(value.skillParams);
  if (skillParams !== undefined) account.skillParams = skillParams;
  const syncIntervalMinutes = optionalNum(value, 'syncIntervalMinutes');
  if (syncIntervalMinutes !== undefined) account.syncIntervalMinutes = syncIntervalMinutes;
  const lastAlertedThresholdPct = optionalNum(value, 'lastAlertedThresholdPct');
  if (lastAlertedThresholdPct !== undefined) account.lastAlertedThresholdPct = lastAlertedThresholdPct;
  const lastAlertPeriodStart = optionalStr(value, 'lastAlertPeriodStart');
  if (lastAlertPeriodStart !== undefined) account.lastAlertPeriodStart = lastAlertPeriodStart;

  if (account.alertThresholdsPct.length === 0) account.alertThresholdsPct = [80, 100];
  return account;
}

function parseEntry(value: unknown, index: number): UsageEntry {
  const where = `relevé n° ${index + 1}`;
  if (!isRecord(value)) fail(`${where} : objet attendu`);
  const recordedAt = str(value, 'recordedAt', where);
  if (Number.isNaN(new Date(recordedAt).getTime()))
    fail(`${where} : champ « recordedAt » n'est pas une date`);

  const entry: UsageEntry = {
    id: str(value, 'id', where),
    accountId: str(value, 'accountId', where),
    recordedAt,
    value: num(value, 'value', where),
    mode: oneOf(value, 'mode', ENTRY_MODES, where),
    source: oneOf(value, 'source', ENTRY_SOURCES, where),
  };
  const comment = optionalStr(value, 'comment');
  if (comment !== undefined) entry.comment = comment;
  const skillRunId = optionalStr(value, 'skillRunId');
  if (skillRunId !== undefined) entry.skillRunId = skillRunId;
  return entry;
}

// `currentSchemaVersion` vient de `electron/db.ts` — la base est seule
// dépositaire de sa version, ce module ne la duplique pas.
export function parseBackup(text: string, currentSchemaVersion: number): ParseBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "fichier illisible : ce n'est pas du JSON" };
  }

  try {
    if (!isRecord(raw)) fail('fichier illisible : un objet JSON était attendu');
    if (raw.app !== BACKUP_APP_ID) {
      fail("ce fichier n'est pas une sauvegarde Mister Quota (champ « app » absent ou différent)");
    }
    const formatVersion = raw.formatVersion;
    if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
      fail('format de sauvegarde inconnu (champ « formatVersion »)');
    }
    if (formatVersion > BACKUP_FORMAT_VERSION) {
      fail(
        `sauvegarde au format ${formatVersion}, cette version de l'application ne connaît que le format ${BACKUP_FORMAT_VERSION}`,
      );
    }
    const schemaVersion = raw.schemaVersion;
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
      fail('version de schéma inconnue (champ « schemaVersion »)');
    }
    if (schemaVersion > currentSchemaVersion) {
      fail(
        `sauvegarde écrite avec le schéma de base v${schemaVersion}, cette version de l'application s'arrête à v${currentSchemaVersion} : mets l'application à jour avant de restaurer`,
      );
    }
    if (!Array.isArray(raw.accounts)) fail('champ « accounts » absent ou invalide');
    if (!Array.isArray(raw.entries)) fail('champ « entries » absent ou invalide');

    const accounts = raw.accounts.map(parseAccount);
    const entries = raw.entries.map(parseEntry);

    const accountIds = new Set<string>();
    for (const a of accounts) {
      if (accountIds.has(a.id)) fail(`deux comptes portent le même identifiant`);
      accountIds.add(a.id);
    }
    const entryIds = new Set<string>();
    for (const [i, e] of entries.entries()) {
      if (entryIds.has(e.id)) fail(`deux relevés portent le même identifiant`);
      entryIds.add(e.id);
      // La base impose la clé étrangère : un relevé orphelin ferait échouer la
      // restauration à mi-chemin. On refuse avant d'avoir rien écrit.
      if (!accountIds.has(e.accountId)) {
        fail(`relevé n° ${i + 1} : rattaché à un compte absent de la sauvegarde`);
      }
    }

    return {
      ok: true,
      backup: {
        schemaVersion,
        exportedAt: optionalStr(raw, 'exportedAt') ?? '',
        accounts,
        entries,
      },
    };
  } catch (err) {
    if (err instanceof SchemaError) return { ok: false, error: err.message };
    throw err;
  }
}
