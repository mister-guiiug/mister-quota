import { describe, expect, it } from 'vitest';
import { collectionWarning, diagnoseCollection, stubSkillRunError } from './collection';
import type { SkillDescriptor } from './collection';

const REAL: SkillDescriptor = { id: 'openai', label: 'OpenAI', implemented: true };
const STUB: SkillDescriptor = { id: 'cursor', label: 'Cursor', implemented: false };
const SKILLS = [REAL, STUB];

describe('diagnoseCollection', () => {
  it('ne signale rien pour une saisie manuelle sans connecteur', () => {
    expect(diagnoseCollection({ collection: 'manual' }, SKILLS)).toEqual({ kind: 'manual' });
  });

  it('ne signale rien pour une collecte automatique servie par un vrai connecteur', () => {
    expect(diagnoseCollection({ collection: 'auto', skillId: 'openai' }, SKILLS)).toEqual({ kind: 'ok' });
  });

  it('signale une collecte automatique sans connecteur choisi', () => {
    expect(diagnoseCollection({ collection: 'auto' }, SKILLS)).toEqual({ kind: 'missing_skill' });
  });

  it('signale un connecteur squelette', () => {
    expect(diagnoseCollection({ collection: 'auto', skillId: 'cursor' }, SKILLS)).toEqual({
      kind: 'stub_skill',
      skillId: 'cursor',
      label: 'Cursor',
    });
  });

  it('signale un connecteur absent du registre (compte importé, connecteur retiré)', () => {
    expect(diagnoseCollection({ collection: 'auto', skillId: 'disparu' }, SKILLS)).toEqual({
      kind: 'unknown_skill',
      skillId: 'disparu',
    });
  });

  it('signale le squelette même en saisie manuelle : le bouton « Synchroniser » est affiché dès qu’un connecteur est rattaché', () => {
    expect(diagnoseCollection({ collection: 'manual', skillId: 'cursor' }, SKILLS)).toEqual({
      kind: 'stub_skill',
      skillId: 'cursor',
      label: 'Cursor',
    });
  });
});

describe('collectionWarning', () => {
  it('reste muet quand la collecte peut avoir lieu', () => {
    expect(collectionWarning({ collection: 'manual' }, SKILLS)).toBeNull();
    expect(collectionWarning({ collection: 'auto', skillId: 'openai' }, SKILLS)).toBeNull();
    expect(collectionWarning({ collection: 'hybrid', skillId: 'openai' }, SKILLS)).toBeNull();
  });

  it('nomme le connecteur et renvoie vers la saisie manuelle', () => {
    const message = collectionWarning({ collection: 'auto', skillId: 'cursor' }, SKILLS);
    expect(message).toContain('Cursor');
    expect(message).toContain('automatique');
    expect(message).toContain('à la main');
  });

  it('dit « hybride » quand le compte est hybride', () => {
    expect(collectionWarning({ collection: 'hybrid', skillId: 'cursor' }, SKILLS)).toContain('hybride');
  });

  // Le cœur du mécanisme : le diagnostic ne connaît AUCUN nom de connecteur.
  // Le jour où l'appel HTTP de Cursor est écrit, il suffit de passer son
  // drapeau à `true` — sans toucher à l'interface — pour que l'avertissement
  // disparaisse partout. Si quelqu'un recode une liste de noms en dur, ce test
  // tombe.
  it('se tait dès que le connecteur se déclare opérationnel, sans autre changement', () => {
    const promu = SKILLS.map((s) => ({ ...s, implemented: true }));
    expect(collectionWarning({ collection: 'auto', skillId: 'cursor' }, promu)).toBeNull();
  });

  // Symétrique : un connecteur aujourd'hui réel qui redeviendrait squelette est
  // signalé sans qu'une ligne d'interface bouge.
  it('parle dès qu’un connecteur réel se déclare squelette', () => {
    const degrade = SKILLS.map((s) => ({ ...s, implemented: false }));
    expect(collectionWarning({ collection: 'auto', skillId: 'openai' }, degrade)).toContain('OpenAI');
  });
});

describe('stubSkillRunError', () => {
  it('écrit dans le journal une phrase destinée à l’utilisateur, pas au développeur', () => {
    const message = stubSkillRunError(STUB);
    expect(message).toContain('Cursor');
    expect(message).toContain('squelette');
    expect(message).toContain('aucune donnée');
  });
});
