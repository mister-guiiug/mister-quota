import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';

// Cursor exposes usage via its dashboard API. The exact endpoint changes
// often and isn't officially documented, so this skill expects:
//   secret: apiKey  (Cursor session token / API key the user copies in)
//   param:  workspaceId (optional)
// On invocation it returns a normalized SkillUsageReport.
//
// Until the user wires real credentials, this is a thin stub that throws —
// rather than silently returning fake numbers — so the dashboard surfaces
// "skill misconfigured" instead of wrong data.
export const cursorSkill: Skill = {
  id: 'cursor',
  label: 'Cursor',
  provider: 'cursor',
  requiredSecrets: ['apiKey'],
  requiredParams: [],
  async fetch(ctx): Promise<SkillUsageReport> {
    const apiKey = ctx.secrets.apiKey;
    if (!apiKey) throw new Error('cursor skill: missing apiKey secret');

    const period = resolvePeriod(ctx.account.periodRule);

    // TODO: replace with real HTTP call to the Cursor usage endpoint.
    // Example (pseudo):
    //   const res = await fetch('https://cursor.sh/api/usage', { headers: { Authorization: `Bearer ${apiKey}` } });
    //   const json = await res.json();
    throw new Error('cursor skill: live API call not yet implemented — wire your endpoint here');

    // Once implemented, return shape:
    // return {
    //   provider: 'cursor',
    //   accountId: ctx.account.id,
    //   retrievedAt: new Date().toISOString(),
    //   period: { start: period.start, end: period.end, type: period.type, timezone: period.timezone },
    //   usage: { unit: 'tokens', quota: ctx.account.quota, consumed: <fromAPI>, mode: 'cumulative', confidence: 'exact' },
    //   raw: { source: 'api', reference: 'cursor-usage' },
    // };
  },
};
