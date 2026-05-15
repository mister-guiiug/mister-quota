import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';

// OpenAI usage via the Admin API.
//   secret: adminApiKey
//   param:  projectId (optional — omit for org-wide totals)
export const openaiSkill: Skill = {
  id: 'openai',
  label: 'OpenAI',
  provider: 'openai',
  requiredSecrets: ['adminApiKey'],
  requiredParams: [],
  async fetch(ctx): Promise<SkillUsageReport> {
    const apiKey = ctx.secrets.adminApiKey;
    if (!apiKey) throw new Error('openai skill: missing adminApiKey secret');

    const period = resolvePeriod(ctx.account.periodRule);
    const _url = `https://api.openai.com/v1/organization/usage/completions?start_time=${Math.floor(new Date(period.start).getTime() / 1000)}&end_time=${Math.floor(new Date(period.end).getTime() / 1000)}`;
    // TODO: live HTTP call + summing across pages.
    throw new Error('openai skill: live API call not yet implemented — wire your endpoint here');
  },
};
