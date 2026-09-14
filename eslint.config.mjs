// Config ESLint du dépôt — flat config, sur la base partagée du socle famille.
//
// Extension `.mjs`, pour la même raison que `vite.config.mts` : ce
// `package.json` n'a pas `"type": "module"` — le processus principal Electron
// est compilé en CommonJS — et un `eslint.config.js` écrit en ESM fait alors
// sortir Node en `MODULE_TYPELESS_PACKAGE_JSON`, en annonçant une relecture
// coûteuse. `.mjs` le déclare sans toucher au reste du dépôt.
//
// Elle remplace un `.eslintrc.cjs` qui vivait en ESLint 8 avec son propre
// assemblage (`@typescript-eslint/*`, `eslint-plugin-react`,
// `eslint-config-prettier`). Le socle porte désormais ces plugins en peers, et
// `eslint-plugin-react` n'en fait pas partie : la base famille s'appuie sur
// `react-hooks`, `react-refresh` et `jsx-a11y`, dont les règles a11y et React
// Compiler sont en `warn` — visibles sans bloquer la CI.
//
// `eslint-config-prettier` disparaît avec : les règles de mise en forme ne sont
// plus dans les `recommended` d'ESLint ni de typescript-eslint, il n'y a donc
// plus de conflit à éteindre. C'est ce que fait déjà le reste du parc.
import base from '@mister-guiiug/dev-pwa-config/eslint-react';

export default [
  ...base,

  // La base ignore déjà `dist`, `node_modules`, `dev-dist`, `coverage` et
  // `.claude/worktrees`. Restent les deux sorties propres à une app Electron.
  { ignores: ['dist-electron/**', 'release/**'] },

  // LES TROIS DIVERGENCES DU DÉPÔT, REPRISES DE L'ANCIENNE CONFIG.
  //
  // Elles ne sont pas un oubli de migration : chacune était inscrite dans
  // `.eslintrc.cjs` et vaut toujours pour ce code.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Le pont `preload`/IPC et la couche SQLite manipulent des valeurs dont
      // le type ne se connaît qu'à l'exécution. La base famille laisse
      // `no-explicit-any` en erreur ; ici il reste éteint, comme avant.
      '@typescript-eslint/no-explicit-any': 'off',
      // Le processus principal est compilé en CommonJS : un import de type qui
      // n'est pas marqué `type` survit à la compilation et devient un `require`
      // au moment de l'exécution. La règle n'est donc pas cosmétique.
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // Un `catch {}` vide est la façon normale d'écrire « cet échec ne change
      // rien » — typiquement une lecture de fichier facultative au démarrage.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
