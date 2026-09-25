import type { Skill, SkillUsageReport } from '../../shared/types';
import { resolvePeriod } from '../../shared/period';
import { fetchWithRetry } from '../http';
import {
  DAY_MS,
  USER_AGENT,
  centsToDollars,
  count,
  explainFailure,
  isUsd,
  unsupportedUnit,
  usageReport,
  usdNote,
  utcDays,
  utcDaysNote,
} from './common';

// Claude — API d'administration « Usage & Cost » d'Anthropic.
//
//   secret : adminApiKey — clé Admin d'ORGANISATION (`sk-ant-admin01-…`), que
//            seul un membre de rôle admin peut créer, dans Console › Settings ›
//            Admin keys. Une clé d'API de workspace (la clé ordinaire) est
//            refusée, et l'API n'existe pas pour un compte individuel (ni pour
//            Claude Enterprise, qui a sa propre API d'analytique).
//   paramètre : aucun. L'organisation se déduit de la clé.
//
// L'ANCIEN `organizationId`. Le squelette le réclamait pour une URL
// `/v1/organizations/{orgId}/…` qui n'existe pas. Il a quitté les paramètres
// requis ; un compte enregistré avant le porte encore dans `skillParams`, et
// c'est sans effet : plus rien ne le lit.
//
// Unités : `tokens` ← usage_report/messages, toutes catégories de jetons ;
// `currency` ← cost_report, en dollars. `requests` et `credits` n'existent pas
// dans cette API : erreur explicite, jamais un chiffre de remplacement.
//
// Les deux rapports rangent leurs chiffres en jours UTC (voir `utcDays`) : une
// période qui ne s'ouvre pas à minuit UTC est comptée sur les jours UTC les
// plus proches, et le rapport est alors `estimated`.

const API = 'https://api.anthropic.com/v1/organizations';
const ANTHROPIC_VERSION = '2023-06-01';

// 31 seaux d'un jour par page : le maximum documenté pour `bucket_width=1d`
// (et pour le rapport de coûts). Une période mensuelle tient en une page.
const BUCKETS_PER_PAGE = 31;

// Garde-fou contre une pagination qui ne finirait pas : 40 pages de 31 jours
// couvrent plus de trois ans, bien au delà de toute période de quota.
const MAX_PAGES = 40;

interface UsageResult {
  uncached_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } | null;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface CostResult {
  // Centimes, en chaîne décimale : "123.45" en USD vaut 1,2345 $.
  amount?: string | number;
  currency?: string | null;
}

interface ReportPage<R> {
  data?: Array<{ results?: R[] }>;
  has_more?: boolean;
  next_page?: string | null;
}

export const claudeSkill: Skill = {
  id: 'claude',
  label: 'Claude (Anthropic)',
  provider: 'claude',
  requiredSecrets: ['adminApiKey'],
  requiredParams: [],
  implemented: true,
  async fetch(ctx): Promise<SkillUsageReport> {
    const { account } = ctx;
    // L'unité d'abord : aucune clé ne rendra des requêtes ou des crédits.
    if (account.unit !== 'tokens' && account.unit !== 'currency') {
      throw unsupportedUnit(
        'API Anthropic',
        account.unit,
        'elle ne compte que des jetons (unité « Tokens ») et des coûts (unité « Devise »)',
      );
    }
    const apiKey = ctx.secrets.adminApiKey?.trim();
    if (!apiKey) {
      throw new Error(
        'Clé Admin Anthropic absente : renseigne « adminApiKey » dans le formulaire du compte (clé sk-ant-admin01-…).',
      );
    }

    const period = resolvePeriod(account.periodRule);
    const days = utcDays(period);
    // `ending_at` ne retient que les seaux qui se TERMINENT avant lui : pour
    // compter aujourd'hui, il faut viser la fin du jour UTC en cours. Au delà,
    // on demanderait des jours qui n'ont pas commencé.
    const endingAt = Math.min(days.end, Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS);
    const notes: string[] = [];
    let estimated = false;
    if (!days.aligned) {
      notes.push(utcDaysNote(period, days.start));
      estimated = true;
    }

    let consumed = 0;
    let source: string;
    if (account.unit === 'tokens') {
      source = 'anthropic usage_report/messages';
      const results = await fetchReport<UsageResult>(
        'usage_report/messages',
        { bucket_width: '1d' },
        days.start,
        endingAt,
        apiKey,
      );
      for (const r of results) {
        consumed +=
          count(r.uncached_input_tokens) +
          count(r.cache_creation?.ephemeral_1h_input_tokens) +
          count(r.cache_creation?.ephemeral_5m_input_tokens) +
          count(r.cache_read_input_tokens) +
          count(r.output_tokens);
      }
    } else {
      source = 'anthropic cost_report';
      const results = await fetchReport<CostResult>('cost_report', {}, days.start, endingAt, apiKey);
      let cents = 0;
      for (const r of results) cents += amountInCents(r);
      consumed = centsToDollars(cents);
      // Pas de conversion : le taux du jour n'est pas celui de la facture, et
      // un montant converti se ferait passer pour exact.
      if (!isUsd(account.currency)) {
        notes.push(usdNote(account));
        estimated = true;
      }
    }

    return usageReport({
      provider: 'claude',
      account,
      period,
      consumed,
      currency: account.unit === 'currency' ? 'USD' : undefined,
      estimated,
      reference: [source, ...notes].join(' · '),
    });
  },
};

// Tous les résultats de tous les seaux de [from, to), page après page. Une
// fenêtre vide (les premières heures d'une période ouverte avant minuit UTC)
// ne demande rien : il n'y a encore aucun jour UTC à compter.
async function fetchReport<R>(
  path: string,
  extra: Record<string, string>,
  from: number,
  to: number,
  apiKey: string,
): Promise<R[]> {
  if (from >= to) return [];
  const query = new URLSearchParams({
    starting_at: rfc3339(from),
    ending_at: rfc3339(to),
    ...extra,
    limit: String(BUCKETS_PER_PAGE),
  });
  const results: R[] = [];
  let page: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    if (page) query.set('page', page);
    const body = await get<ReportPage<R>>(`${API}/${path}?${query}`, apiKey);
    if (!Array.isArray(body?.data)) throw unexpected(path);
    // Un seau sans usage porte une liste VIDE : un seau sans liste, ou une
    // liste qui contient autre chose que des objets, n'est pas au contrat.
    for (const bucket of body.data) {
      if (!Array.isArray(bucket?.results)) throw unexpected(path);
      for (const r of bucket.results) {
        if (!r || typeof r !== 'object') throw unexpected(path);
        results.push(r);
      }
    }
    if (!body.has_more) return results;
    // `has_more` sans curseur neuf : continuer reviendrait à relire la même
    // page, et s'arrêter à rendre un total amputé.
    if (!body.next_page || body.next_page === page) throw unexpected(path);
    page = body.next_page;
  }
  throw new Error(
    `L'API Anthropic (${path}) annonce plus de ${MAX_PAGES} pages : pagination interrompue par prudence.`,
  );
}

async function get<T>(url: string, apiKey: string): Promise<T> {
  try {
    return await fetchWithRetry<T>({
      url,
      init: {
        headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'user-agent': USER_AGENT },
      },
      retries: 3,
    });
  } catch (err) {
    throw explainFailure(err, 'API Anthropic', (status) => advice(status, apiKey));
  }
}

function advice(status: number, apiKey: string): string | undefined {
  if (status === 401 || status === 403) {
    const hint = apiKey.startsWith('sk-ant-admin')
      ? ''
      : " La clé enregistrée ne commence pas par « sk-ant-admin » : c'est sans doute une clé d'API ordinaire.";
    return (
      `Clé refusée par l'API Anthropic (HTTP ${status}) : l'API Usage & Cost n'accepte qu'une clé Admin ` +
      `d'organisation (sk-ant-admin01-…), qu'un administrateur crée dans Console › Settings › Admin keys.${hint}`
    );
  }
  if (status === 404) {
    return (
      "L'API Usage & Cost ne répond pas (HTTP 404) : elle n'est ouverte qu'aux organisations de la Console " +
      "Claude — ni aux comptes individuels, ni à Claude Enterprise, qui passe par son API d'analytique."
    );
  }
  return undefined;
}

// Les montants sont des centimes en chaîne décimale. Un montant illisible ou
// une autre devise que l'USD arrêtent tout : les additionner quand même
// rendrait un total faux, sans rien qui le signale.
function amountInCents(r: CostResult): number {
  if (r.currency != null && r.currency !== 'USD') {
    throw new Error(
      `L'API Anthropic (cost_report) rend un montant en « ${r.currency} » : seul l'USD est attendu.`,
    );
  }
  const cents =
    typeof r.amount === 'number'
      ? r.amount
      : typeof r.amount === 'string' && /^-?\d+(\.\d+)?$/.test(r.amount.trim())
        ? Number(r.amount)
        : Number.NaN;
  if (!Number.isFinite(cents)) {
    throw new Error(`L'API Anthropic (cost_report) rend un montant illisible : « ${String(r.amount)} ».`);
  }
  return cents;
}

function unexpected(path: string): Error {
  return new Error(
    `Réponse inattendue de l'API Anthropic (${path}) : son format ne correspond pas à la documentation.`,
  );
}

// RFC 3339 sans millisecondes, comme dans les exemples de la documentation.
function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
