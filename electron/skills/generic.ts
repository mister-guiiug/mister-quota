import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';

// "Generic" skill — useful as a smoke-test connector and as a template for
// new providers. It returns the most-recent manual entry (if any) packaged
// as a SkillUsageReport, so the dashboard can demonstrate the round-trip
// even before a real API is wired.
export const genericManualSkill: Skill = {
  id: 'generic',
  label: 'Generic (echo last manual entry)',
  provider: 'other',
  requiredSecrets: [],
  requiredParams: [],
  async fetch(ctx): Promise<SkillUsageReport> {
    const period = resolvePeriod(ctx.account.periodRule);
    return {
      provider: 'other',
      accountId: ctx.account.id,
      retrievedAt: new Date().toISOString(),
      period: { start: period.start, end: period.end, type: period.type, timezone: period.timezone },
      usage: {
        unit: ctx.account.unit,
        currency: ctx.account.currency,
        quota: ctx.account.quota,
        consumed: 0, // caller can ignore this and rely on manual entries
        mode: 'cumulative',
        confidence: 'estimated',
      },
      raw: { source: 'manual_import', reference: 'generic-stub' },
    };
  },
};
