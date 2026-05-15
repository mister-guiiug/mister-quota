import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';
import { fetchWithRetry } from '../http';

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
    const url = `https://api.openai.com/v1/organization/usage/completions?start_time=${Math.floor(new Date(period.start).getTime() / 1000)}&end_time=${Math.floor(new Date(period.end).getTime() / 1000)}`;

    // Use the retry helper so transient 429/5xx don't fail a sync. The
    // shape of the OpenAI response is summarized into a single `consumed`
    // value here; replace `n_tokens_total` with the field that matches
    // the user's quota unit (tokens / cost_usd / requests).
    const resp = await fetchWithRetry<{ data?: Array<{ n_tokens_total?: number }> }>({
      url,
      init: { headers: { authorization: `Bearer ${apiKey}` } },
      retries: 3,
    });
    const consumed = (resp.data ?? []).reduce((sum, row) => sum + (row.n_tokens_total ?? 0), 0);

    return {
      schemaVersion: 1,
      provider: 'openai',
      accountId: ctx.account.id,
      retrievedAt: new Date().toISOString(),
      period: { start: period.start, end: period.end, type: period.type, timezone: period.timezone },
      usage: {
        unit: ctx.account.unit,
        currency: ctx.account.currency,
        quota: ctx.account.quota,
        consumed,
        mode: 'cumulative',
        confidence: 'estimated',
      },
      raw: { source: 'api', reference: 'openai-usage-completions' },
    };
  },
};
