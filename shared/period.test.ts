// `shared/period.ts` n'avait AUCUN test — le module le plus délicat du dépôt,
// celui qui décide où commence et où finit un quota.
//
// CE QUE CES TESTS FIXENT, ET CE QU'ILS ÉVITENT DE FIXER. Une borne de période
// dépend de deux choses : la règle du compte, et les règles de fuseau d'IANA.
// La première nous appartient, la seconde NON — le Chili a déjà déplacé ses
// bascules plusieurs fois, et un test qui épinglerait « 04:00Z » virerait au
// rouge le jour où `tzdata` bouge, sans qu'une ligne du dépôt ait changé.
//
// Les assertions portent donc sur des PROPRIÉTÉS chaque fois qu'un fuseau à
// changement d'heure est en jeu (« la borne tombe à minuit local », « la borne
// tombe le bon jour local »), et sur des constantes uniquement là où le compte
// est en `UTC`, qui ne bouge pas.
//
// Le test central est `le fuseau de la machine n'influence aucune borne` : il
// échoue sur l'implémentation `date-fns-tz` d'avant, et il n'a besoin d'aucune
// connaissance de `tzdata` pour ça — il compare les résultats ENTRE EUX.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TZDate } from '@date-fns/tz';
import { resolvePeriod, previousPeriod } from './period';
import type { PeriodRule } from './types';

const TZ_ORIGINE = process.env.TZ;

/**
 * Fixe le fuseau de la MACHINE.
 *
 * Node relit `process.env.TZ` à l'affectation — vérifié : `getTimezoneOffset()`
 * et `Intl` suivent tous les deux. C'est indispensable ici : la CI tourne en
 * UTC, qui n'a pas de changement d'heure, et n'exposerait donc jamais un bug
 * dont c'est précisément le déclencheur.
 */
function machineEn(zone: string): void {
  process.env.TZ = zone;
}

afterAll(() => {
  if (TZ_ORIGINE === undefined) delete process.env.TZ;
  else process.env.TZ = TZ_ORIGINE;
});

/** Les champs locaux d'un instant, lus dans le fuseau visé. */
function champsLocaux(iso: string, zone: string) {
  const d = new TZDate(new Date(iso).getTime(), zone);
  return {
    annee: d.getFullYear(),
    mois: d.getMonth() + 1,
    jour: d.getDate(),
    heure: d.getHours(),
    minute: d.getMinutes(),
  };
}

describe('resolvePeriod', () => {
  beforeAll(() => machineEn('UTC'));

  it('le fuseau de la MACHINE n’influence aucune borne', () => {
    // Le cœur de la bascule vers `@date-fns/tz`. Avec `date-fns-tz`, la valeur
    // « zonée » était une `Date` menteuse : `addDays` la traitait comme une
    // date locale ordinaire et repartait dans le fuseau du poste. Un compte en
    // `UTC` voyait sa semaine finir à 23:00Z si l'application tournait à Paris
    // la nuit du passage à l'heure d'été.
    const regles: PeriodRule[] = [
      { type: 'weekly', weekday: 1, timezone: 'UTC' },
      { type: 'weekly', weekday: 7, timezone: 'Europe/Paris' },
      { type: 'weekly', weekday: 4, timezone: 'Australia/Sydney' },
      { type: 'monthly', dayOfMonth: 31, timezone: 'UTC' },
      { type: 'monthly', dayOfMonth: 15, timezone: 'Asia/Kolkata' },
      { type: 'yearly', month: 2, day: 29, timezone: 'Europe/Paris' },
      { type: 'custom', startDate: '2026-01-15T00:00:00Z', periodLengthDays: 30, timezone: 'UTC' },
      {
        type: 'custom',
        startDate: '2026-01-15T00:00:00Z',
        periodLengthDays: 7,
        timezone: 'America/Santiago',
      },
    ];
    // Des instants pris de part et d'autre des bascules des deux hémisphères.
    const instants = [
      '2026-03-28T23:30:00Z',
      '2026-03-29T00:30:00Z',
      '2026-03-29T12:30:00Z',
      '2026-04-05T02:30:00Z',
      '2026-09-06T08:17:00Z',
      '2026-10-25T00:30:00Z',
      '2026-11-01T06:00:00Z',
    ].map((s) => new Date(s));

    // Et des fuseaux machine volontairement hostiles : décalages à la demi-heure
    // et au quart d'heure, changements d'heure inversés.
    const postes = [
      'UTC',
      'Europe/Paris',
      'America/New_York',
      'Australia/Sydney',
      'Asia/Kolkata',
      'Pacific/Chatham',
    ];

    for (const rule of regles) {
      for (const now of instants) {
        machineEn('UTC');
        const reference = resolvePeriod(rule, now);
        for (const poste of postes) {
          machineEn(poste);
          expect(
            resolvePeriod(rule, now),
            `règle ${JSON.stringify(rule)} à ${now.toISOString()} depuis ${poste}`,
          ).toEqual(reference);
        }
      }
    }
    machineEn('UTC');
  });

  it('sort toujours un ISO en Z, pas la forme décalée de TZDate', () => {
    // `TZDate.toISOString()` rend `…+05:30`. La forme désigne le même instant,
    // mais `lastAlertPeriodStart` (electron/alerts.ts) est comparé par égalité
    // de CHAÎNE : un changement de forme relancerait une alerte à chaque tour.
    const p = resolvePeriod(
      { type: 'monthly', dayOfMonth: 1, timezone: 'Asia/Kolkata' },
      new Date('2026-06-15T00:00:00Z'),
    );
    expect(p.start).toMatch(/Z$/);
    expect(p.end).toMatch(/Z$/);
    expect(new Date(p.start).toISOString()).toBe(p.start);
  });

  describe('hebdomadaire', () => {
    it('cadre la semaine sur le bon lundi, en UTC', () => {
      // Compte en UTC : les constantes sont sûres, UTC ne bouge pas.
      const p = resolvePeriod(
        { type: 'weekly', weekday: 1, timezone: 'UTC' },
        new Date('2026-03-29T00:30:00Z'), // un dimanche
      );
      expect(p.start).toBe('2026-03-23T00:00:00.000Z');
      expect(p.end).toBe('2026-03-30T00:00:00.000Z');
    });

    it('garde ses deux bornes à minuit LOCAL malgré le changement d’heure', () => {
      // Du côté d'un compte parisien, la semaine qui enjambe le passage à
      // l'heure d'été dure 167 heures — mais elle commence et finit à minuit.
      // C'est la propriété qui compte ; l'heure UTC exacte, elle, dépend de
      // `tzdata` et n'a pas à être gravée ici.
      const p = resolvePeriod(
        { type: 'weekly', weekday: 1, timezone: 'Europe/Paris' },
        new Date('2026-03-29T12:00:00Z'),
      );
      for (const borne of [p.start, p.end]) {
        const c = champsLocaux(borne, 'Europe/Paris');
        expect({ heure: c.heure, minute: c.minute }).toEqual({ heure: 0, minute: 0 });
      }
      expect(champsLocaux(p.start, 'Europe/Paris').jour).toBe(23);
      expect(champsLocaux(p.end, 'Europe/Paris').jour).toBe(30);
    });

    it('tombe sur le bon jour local même quand ce jour n’a pas de minuit', () => {
      // Au Chili, le jour où l'heure d'été commence débute à 01:00 : 00:00
      // n'existe pas. `date-fns-tz` résolvait ce minuit introuvable vers le
      // décalage d'APRÈS bascule, ce qui ramenait le début de semaine à la
      // veille au soir. La propriété attendue est simple : le début de la
      // semaine du dimanche tombe UN DIMANCHE.
      const p = resolvePeriod(
        { type: 'weekly', weekday: 7, timezone: 'America/Santiago' },
        new Date('2026-09-06T08:17:00Z'),
      );
      const debut = new TZDate(new Date(p.start).getTime(), 'America/Santiago');
      expect(debut.getDay()).toBe(0); // 0 = dimanche
      expect(champsLocaux(p.start, 'America/Santiago').jour).toBe(6);
    });
  });

  describe('mensuel', () => {
    it('ramène le 31 à la longueur du mois', () => {
      const p = resolvePeriod(
        { type: 'monthly', dayOfMonth: 31, timezone: 'UTC' },
        new Date('2026-02-10T00:00:00Z'),
      );
      // Février 2026 n'a que 28 jours : l'ancre est le 28.
      expect(p.start).toBe('2026-01-31T00:00:00.000Z');
      expect(p.end).toBe('2026-02-28T00:00:00.000Z');
    });

    it('repart sur le mois précédent quand l’ancre n’est pas encore passée', () => {
      const p = resolvePeriod(
        { type: 'monthly', dayOfMonth: 15, timezone: 'UTC' },
        new Date('2026-06-03T00:00:00Z'),
      );
      expect(p.start).toBe('2026-05-15T00:00:00.000Z');
      expect(p.end).toBe('2026-06-15T00:00:00.000Z');
    });
  });

  describe('annuel', () => {
    it('ramène le 29 février au 28 les années non bissextiles', () => {
      const p = resolvePeriod(
        { type: 'yearly', month: 2, day: 29, timezone: 'UTC' },
        new Date('2027-06-01T00:00:00Z'),
      );
      expect(p.start).toBe('2027-02-28T00:00:00.000Z');
      expect(p.end).toBe('2028-02-29T00:00:00.000Z'); // 2028 est bissextile
    });
  });

  describe('personnalisé', () => {
    it('empile les cycles depuis l’ancre sans dériver', () => {
      const rule: PeriodRule = {
        type: 'custom',
        startDate: '2026-01-15T00:00:00Z',
        periodLengthDays: 30,
        timezone: 'UTC',
      };
      // 2026-06-01 est à 137 jours de l'ancre, soit 4 cycles pleins (120 j).
      const p = resolvePeriod(rule, new Date('2026-06-01T12:00:00Z'));
      expect(p.start).toBe('2026-05-15T00:00:00.000Z');
      expect(p.end).toBe('2026-06-14T00:00:00.000Z');
    });

    it('rend la fenêtre précédente jointive', () => {
      const rule: PeriodRule = {
        type: 'custom',
        startDate: '2026-01-15T00:00:00Z',
        periodLengthDays: 30,
        timezone: 'UTC',
      };
      const courante = resolvePeriod(rule, new Date('2026-06-01T12:00:00Z'));
      const avant = previousPeriod(rule, courante);
      expect(avant.end).toBe(courante.start);
    });
  });
});
