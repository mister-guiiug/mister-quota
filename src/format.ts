// Number/date formatting helpers shared across views.

import type { Account, Unit } from '@shared/types';

const COMPACT = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 });
const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

export function fmtUnit(value: number, unit: Unit, currency?: string): string {
  if (!Number.isFinite(value)) return '∞';
  switch (unit) {
    case 'tokens':
    case 'requests':
    case 'credits':
      return `${COMPACT.format(value)} ${unit}`;
    case 'currency':
      return new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: currency ?? 'EUR',
        maximumFractionDigits: 2,
      }).format(value);
  }
}

export function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return PCT.format(value / 100);
}

export function fmtDate(iso: string): string {
  return DATE.format(new Date(iso));
}

export function fmtDays(d: number): string {
  if (!Number.isFinite(d)) return '—';
  if (d < 1) return `${(d * 24).toFixed(1)} h`;
  return `${d.toFixed(1)} j`;
}

export function fmtUnitForAccount(value: number, account: Account): string {
  return fmtUnit(value, account.unit, account.currency);
}
