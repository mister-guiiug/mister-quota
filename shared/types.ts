// Shared domain types — used by both the renderer (React) and the main (Electron/Node) processes.
// Keep this file dependency-free so it can be imported anywhere.

export type PeriodType = 'weekly' | 'monthly' | 'yearly' | 'custom';
export type CollectionMethod = 'manual' | 'auto' | 'hybrid';
export type EntrySource = 'manual' | 'skill';
export type EntryMode = 'cumulative' | 'delta';
export type Unit = 'tokens' | 'credits' | 'requests' | 'currency';
export type Provider = 'cursor' | 'claude' | 'openai' | 'other';
export type Status = 'ahead' | 'on_track' | 'behind' | 'over_quota' | 'period_ended';

// ISO weekday: 1 = Monday … 7 = Sunday
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface PeriodRule {
  type: PeriodType;
  // weekly
  weekday?: IsoWeekday;
  // monthly
  dayOfMonth?: number;
  // yearly
  month?: number; // 1..12
  day?: number;   // 1..31
  // custom
  startDate?: string; // ISO date
  periodLengthDays?: number;
  timezone: string; // e.g. "Europe/Paris"
}

export interface Account {
  id: string;
  name: string;
  provider: Provider;
  periodRule: PeriodRule;
  quota: number;
  unit: Unit;
  currency?: string; // when unit === 'currency'
  collection: CollectionMethod;
  skillId?: string;
  skillParams?: Record<string, unknown>; // non-secret part
  tolerancePct: number; // e.g. 3 for ±3%
  createdAt: string;
  updatedAt: string;
}

export interface UsageEntry {
  id: string;
  accountId: string;
  recordedAt: string;     // ISO datetime of the reading
  value: number;          // amount in account.unit
  mode: EntryMode;        // cumulative or delta
  source: EntrySource;
  comment?: string;
  // For skill imports: optional metadata for traceability
  skillRunId?: string;
}

export interface Period {
  start: string; // inclusive
  end: string;   // exclusive
  type: PeriodType;
  timezone: string;
}

// Result of computeAccountState — the value object the dashboard renders.
export interface AccountState {
  account: Account;
  period: Period;
  totalDays: number;
  elapsedDays: number;       // can be fractional
  remainingDays: number;     // can be fractional
  consumed: number;
  idealToDate: number;
  delta: number;             // consumed - idealToDate
  deltaPct: number;          // delta / quota * 100
  status: Status;
  // Indicators required by spec §4.4
  theoreticalDailyPct: number;     // 100 / totalDays
  theoreticalDailyAmount: number;  // quota / totalDays
  requiredDailyAvgRemaining: number; // (quota - consumed) / remainingDays, can be Infinity / negative
  paceDeltaDaily: number;            // (consumed/elapsed) - (quota/total)
  paceDeltaDailyPct: number;         // paceDeltaDaily / theoreticalDailyAmount * 100
  // Forward-looking: extrapolated end-of-period consumption if pace holds
  projectedEndConsumption: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills — connector contract
// ─────────────────────────────────────────────────────────────────────────────

export interface SkillUsageDetail {
  metric: 'input_tokens' | 'output_tokens' | 'requests' | 'other';
  value: number;
}

// The "format standard unique" specified in §6 of the master prompt.
export interface SkillUsageReport {
  provider: Provider;
  accountId: string;
  retrievedAt: string;
  period: {
    start: string;
    end: string;
    type: PeriodType;
    timezone: string;
  };
  usage: {
    unit: Unit;
    currency?: string;
    quota: number;
    consumed: number;
    mode: 'cumulative' | 'delta';
    confidence: 'exact' | 'estimated';
  };
  details?: SkillUsageDetail[];
  raw: {
    source: 'api' | 'scrape' | 'manual_import';
    reference?: string;
  };
}

export interface SkillContext {
  account: Account;
  // Resolved secrets (decrypted from OS keychain at call time).
  secrets: Record<string, string>;
}

export interface Skill {
  id: string;             // 'cursor', 'claude', 'openai', …
  label: string;
  provider: Provider;
  // Declares which secret keys this skill needs (UI uses this to prompt the user).
  requiredSecrets: string[];
  // Declares which non-secret params are needed (e.g. workspace id).
  requiredParams: string[];
  fetch(ctx: SkillContext): Promise<SkillUsageReport>;
}
