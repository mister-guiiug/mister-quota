// Config famille comme base, divergences locales explicites.
//
// Ce dépôt a réglé sa discipline de format AVANT le rattachement au socle
// (PR #2 : format:check en CI, 28 fichiers réalignés). Adopter les valeurs du
// socle telles quelles reformaterait ~40 fichiers d'un coup ; on garde donc
// les trois réglages historiques ci-dessous et on hérite du reste.
import base from '@mister-guiiug/dev-wpa-config/prettier';

export default {
  ...base,
  trailingComma: 'all',
  printWidth: 110,
  arrowParens: 'always',
  endOfLine: 'lf',
};
