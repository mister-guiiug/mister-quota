import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';

// « Generic » — modèle de connecteur, à copier pour écrire un vrai fournisseur.
//
// Son étiquette promettait de renvoyer le dernier relevé manuel ; il renvoie en
// fait `consumed: 0`. Ce zéro n'est pas neutre : `reduceConsumed` traite un
// relevé `cumulative` comme la nouvelle référence de la période, donc une
// synchronisation « réussie » remettrait la consommation affichée à zéro. D'où
// `implemented: false` — le processus principal refuse de le lancer, et
// l'interface annonce le squelette au lieu d'écrire un chiffre faux.
export const genericManualSkill: Skill = {
  id: 'generic',
  label: 'Generic (modèle — ne collecte rien)',
  provider: 'other',
  requiredSecrets: [],
  requiredParams: [],
  implemented: false,
  async fetch(ctx): Promise<SkillUsageReport> {
    const period = resolvePeriod(ctx.account.periodRule);
    return {
      schemaVersion: 1,
      provider: 'other',
      accountId: ctx.account.id,
      retrievedAt: new Date().toISOString(),
      period: { start: period.start, end: period.end, type: period.type, timezone: period.timezone },
      usage: {
        unit: ctx.account.unit,
        currency: ctx.account.currency,
        quota: ctx.account.quota,
        consumed: 0,
        mode: 'cumulative',
        confidence: 'estimated',
      },
      raw: { source: 'manual_import', reference: 'generic-stub' },
    };
  },
};
