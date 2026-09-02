// Number/date formatting helpers shared across views.
//
// Rattaché au socle famille : monnaie et nombres compacts délèguent à
// @mister-guiiug/dev-wpa-config/format (locale par défaut fr-FR, instances
// Intl mémorisées), et la date+heure s'importe directement via son
// `formatDateTime` — l'ancien `fmtDate` en était un décalque octet pour
// octet. Restent locaux, car spécifiques au métier ou volontairement
// divergents :
// - fmtUnit / fmtUnitForAccount : vocabulaire tokens/requests/credits, « ∞ »
//   pour un quota illimité ;
// - fmtPct : entrée en POURCENTAGE 0-100 (formatPercentage du socle attend
//   une proportion 0-1), décimale non forcée (« 42 % », pas « 42,0 % »),
//   « — » pour une valeur non finie ;
// - fmtDays : heures sous un jour, jours au-delà.

import { formatCurrency, formatNumber, getDefaultLocale } from '@mister-guiiug/dev-wpa-config/format';
import type { Account, Unit } from '@shared/types';

const COMPACT: Intl.NumberFormatOptions = { notation: 'compact', maximumFractionDigits: 1 };
const PCT = new Intl.NumberFormat(getDefaultLocale(), { style: 'percent', maximumFractionDigits: 1 });

export function fmtUnit(value: number, unit: Unit, currency?: string): string {
  if (!Number.isFinite(value)) return '∞';
  switch (unit) {
    case 'tokens':
    case 'requests':
    case 'credits':
      return `${formatNumber(value, undefined, COMPACT)} ${unit}`;
    case 'currency':
      return formatCurrency(value, undefined, currency ?? 'EUR');
  }
}

export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return PCT.format(value / 100);
}

export function fmtDays(d: number): string {
  if (!Number.isFinite(d)) return '—';
  if (d < 1) return `${(d * 24).toFixed(1)} h`;
  return `${d.toFixed(1)} j`;
}

export function fmtUnitForAccount(value: number, account: Account): string {
  return fmtUnit(value, account.unit, account.currency);
}
