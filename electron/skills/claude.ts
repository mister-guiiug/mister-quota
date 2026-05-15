import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';

// Anthropic Console exposes usage via the Admin API.
//   secret: adminApiKey  (Console > Settings > Admin keys)
//   param:  organizationId
// Endpoints (as of writing): /v1/organizations/{orgId}/usage_report/messages
export const claudeSkill: Skill = {
  id: 'claude',
  label: 'Claude (Anthropic)',
  provider: 'claude',
  requiredSecrets: ['adminApiKey'],
  requiredParams: ['organizationId'],
  async fetch(ctx): Promise<SkillUsageReport> {
    const adminApiKey = ctx.secrets.adminApiKey;
    if (!adminApiKey) throw new Error('claude skill: missing adminApiKey secret');
    const orgId = (ctx.account.skillParams?.organizationId as string | undefined) ?? '';
    if (!orgId) throw new Error('claude skill: missing organizationId param');

    const period = resolvePeriod(ctx.account.periodRule);
    const _url = `https://api.anthropic.com/v1/organizations/${orgId}/usage_report/messages?starting_at=${period.start}&ending_at=${period.end}`;
    // TODO: implement live HTTP call (fetch + Bearer auth + pagination).
    throw new Error('claude skill: live API call not yet implemented — wire your endpoint here');
  },
};
