// Diagnostic de collecte — fonction pure, partagée renderer ↔ main.
//
// Le README annonce deux façons de suivre sa consommation : la saisie manuelle
// et la collecte automatique par connecteur. Deux des connecteurs livrés sont
// des squelettes : un compte réglé en « automatique » sur l'un d'eux ne collecte
// RIEN. Ce module transforme cet état de fait — déclaré par le connecteur via
// `Skill.implemented` — en un diagnostic affichable, pour que l'interface le
// dise partout plutôt que de laisser l'utilisateur attendre des chiffres qui ne
// viendront jamais.
//
// Aucune liste de noms de connecteurs ici : seul le drapeau compte.

import type { Account, CollectionMethod, Skill } from './types';

// Ce que l'interface connaît d'un connecteur (le renderer ne reçoit jamais
// l'objet `Skill` complet, `fetch` ne traverse pas le pont IPC).
export type SkillDescriptor = Pick<Skill, 'id' | 'label' | 'implemented'>;

export type CollectionDiagnosis =
  | { kind: 'ok' } // collecte automatique servie par un connecteur réel
  | { kind: 'manual' } // saisie manuelle, aucun connecteur attendu
  | { kind: 'missing_skill' } // automatique/hybride sans connecteur choisi
  | { kind: 'unknown_skill'; skillId: string } // connecteur absent du registre
  | { kind: 'stub_skill'; skillId: string; label: string }; // connecteur squelette

export type AccountCollectionShape = Pick<Account, 'collection' | 'skillId'>;

export function diagnoseCollection(
  account: AccountCollectionShape,
  skills: readonly SkillDescriptor[],
): CollectionDiagnosis {
  const skill = account.skillId ? skills.find((s) => s.id === account.skillId) : undefined;
  // L'état du connecteur prime sur la méthode de collecte : même un compte en
  // saisie manuelle expose « Synchroniser maintenant » dès qu'un connecteur est
  // rattaché, et ce bouton échouera.
  if (account.skillId && !skill) return { kind: 'unknown_skill', skillId: account.skillId };
  if (skill && !skill.implemented) return { kind: 'stub_skill', skillId: skill.id, label: skill.label };
  if (account.collection === 'manual') return { kind: 'manual' };
  if (!account.skillId) return { kind: 'missing_skill' };
  return { kind: 'ok' };
}

export function collectionLabel(collection: CollectionMethod): string {
  return { manual: 'manuelle', auto: 'automatique', hybrid: 'hybride' }[collection];
}

// Le message à afficher, ou `null` quand il n'y a rien à signaler.
export function collectionWarning(
  account: AccountCollectionShape,
  skills: readonly SkillDescriptor[],
): string | null {
  const diagnosis = diagnoseCollection(account, skills);
  const automatic = account.collection !== 'manual';
  switch (diagnosis.kind) {
    case 'stub_skill':
      return automatic
        ? `Collecte ${collectionLabel(account.collection)} impossible : le connecteur « ${diagnosis.label} » est un squelette — il n'appelle aucune API et ne remontera aucun chiffre. Saisis les relevés à la main.`
        : `Le connecteur « ${diagnosis.label} » est un squelette : « Synchroniser maintenant » échouera tant que son appel HTTP n'est pas écrit.`;
    case 'unknown_skill':
      return `Connecteur « ${diagnosis.skillId} » introuvable : aucune collecte ne sera faite.`;
    case 'missing_skill':
      return `Collecte ${collectionLabel(account.collection)} demandée, mais aucun connecteur n'est choisi : rien ne sera collecté.`;
    default:
      return null;
  }
}

// Message enregistré dans `skill_runs` quand le processus principal refuse de
// lancer un connecteur squelette (plutôt que d'appeler un `fetch` qui jette une
// phrase destinée aux développeurs).
export function stubSkillRunError(skill: SkillDescriptor): string {
  return `Le connecteur « ${skill.label} » est un squelette : aucun appel n'a été fait, aucune donnée collectée.`;
}
