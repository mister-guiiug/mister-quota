# Mister Quota

Application desktop multiplateforme (Windows / macOS / Linux) pour suivre la consommation de plusieurs comptes IA (Cursor, Claude, OpenAI, …), saisie **manuelle** ou **automatique**, avec affichage de l'**avance / retard** par rapport à la consommation idéale jusqu'à la prochaine date d'anniversaire.

---

## Choix techniques

| Aspect            | Choix                                              | Pourquoi                                                                |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| Runtime desktop   | **Electron** + Vite + React + TypeScript           | Le spec listait Tauri en défaut ; faute de toolchain Rust sur la machine de scaffolding, Electron a été retenu (option n° 2 du spec). La structure reste portable vers Tauri (cf. § "Migration vers Tauri" plus bas). |
| Stockage          | **SQLite via `sql.js`** (WASM, pas de native dep)  | Conforme à l'exigence "SQLite", installable partout sans Visual Studio C++ ni `node-gyp`. Migrations forward-only. |
| Secrets (API keys)| **Electron `safeStorage`** → Keychain / DPAPI / libsecret | Conforme à l'exigence "chiffrés localement via OS keychain".            |
| Dates / TZ        | `date-fns` + `date-fns-tz`                          | Calcul de période robuste aux fuseaux et aux mois courts (clamp 31 → 28/30). |
| Tests             | `vitest`                                            | Suite focalisée sur les fonctions de calcul et la résolution de période. |

---

## Démarrage rapide

Prérequis : Node 20+ (testé avec 25.2). Aucun toolchain natif requis.

```bash
npm install
npm run test            # 15 tests sur les calculs et la résolution de période
npm run build           # build du renderer (Vite → dist/)
npm run dev:electron    # lance Vite + Electron en mode dev
```

Pour packager l'app de bureau (DMG / NSIS / AppImage) :

```bash
npm run build:electron
```

### Depuis VSCode

Le dossier `.vscode/` est commité avec :

- **Tâches** (`Terminal → Run Task…`) :
  - `npm: install` — installation des dépendances
  - `typecheck` — TypeScript renderer + main
  - `test` / `test: watch` — vitest
  - `build: electron (compile main + preload)` — `tsc -p electron/tsconfig.json`
  - `dev: vite (renderer)` — Vite dev server (background)
  - `dev: electron prereqs` — composite (compile electron puis lance Vite). Utilisée comme `preLaunchTask`.
  - `build: production` / `package: desktop (electron-builder)`

- **Run & Debug** (`F5`) :
  - **`Electron: Main + Renderer`** *(compound — recommandé)* : compile electron, démarre Vite en arrière-plan, lance Electron avec `--remote-debugging-port=9223`, puis attache Chrome au renderer. Breakpoints fonctionnels dans `electron/*.ts` **et** `src/**/*.tsx`.
  - **`Electron: Main`** seul — debug du process principal uniquement.
  - **`Electron: Renderer (attach)`** seul — attache à une instance Electron déjà démarrée (port 9223).
  - **`Vitest: current file`** / **`Vitest: all`** — debug d'un test ou de toute la suite.

> Source maps activées (`electron/tsconfig.json` → `sourceMap: true`) — les breakpoints pointent sur le TS d'origine.

> Le mode `npm run dev` (Vite seul, sans Electron) lance l'UI dans le navigateur avec un *preview shim* en mémoire — utile pour démonstration et pour itérer sur l'UI sans Electron.

---

## Architecture

```
mister-quota/
├── shared/                ← code partagé renderer ↔ main (sans dépendance UI)
│   ├── types.ts           ← tous les types domaine (Account, UsageEntry, AccountState, Skill…)
│   ├── period.ts          ← résolution PeriodRule → [start, end) (TZ-aware)
│   ├── calc.ts            ← fonctions pures de calcul (testées)
│   └── ipc.ts             ← contrat IPC typé entre renderer et main
├── electron/              ← processus principal Electron (Node)
│   ├── main.ts            ← bootstrap + handlers IPC
│   ├── preload.ts         ← expose window.api typé via contextBridge
│   ├── db.ts              ← Storage SQLite (sql.js) + migrations
│   ├── secrets.ts         ← SecretsStore (safeStorage)
│   ├── log.ts             ← Logger fichier rotatif
│   └── skills/            ← connecteurs (cursor, claude, openai, generic)
├── src/                   ← renderer React
│   ├── App.tsx            ← navigation 3 vues (dashboard / form / detail)
│   ├── views/
│   │   ├── Dashboard.tsx  ← liste des comptes avec barre de progression et indicateurs
│   │   ├── AccountForm.tsx← création / édition (CRUD comptes + secrets)
│   │   └── AccountDetail.tsx ← courbe réel vs idéal + relevés + sync now
│   ├── format.ts          ← helpers d'affichage (unités, %, dates)
│   ├── previewShim.ts     ← backend in-memory pour le mode "vite dev" sans Electron
│   └── styles.css         ← thème sombre simple
└── tests/
    └── calc.test.ts       ← vérifie reduceConsumed, computeAccountState, resolvePeriod
```

### Flux d'une saisie

1. L'utilisateur ouvre **AccountDetail → + Saisie manuelle** ou clique **Synchroniser maintenant**.
2. Le renderer appelle `window.api.insertEntry(...)` ou `window.api.syncNow(...)` (contextBridge).
3. Le main process écrit dans SQLite (`entries`) via `Storage`.
4. Le calcul `computeAccountState` agrège les entries de la période courante (`reduceConsumed`) et renvoie l'objet `AccountState` riche en indicateurs.
5. Le dashboard / la vue détail re-rend avec les nouvelles valeurs.

---

## Indicateurs calculés (spec § 4.4)

Pour chaque compte, `computeAccountState` retourne :

| Indicateur                       | Formule                                                       |
| -------------------------------- | ------------------------------------------------------------- |
| `consumed`                       | Agrégat des entries (mix cumulative + delta)                  |
| `idealToDate`                    | `quota × (elapsed / total)`                                   |
| `delta` / `deltaPct`             | `consumed − idealToDate` ; `delta / quota × 100`              |
| `status`                         | `ahead` / `on_track` / `behind` / `over_quota` / `period_ended` selon la tolérance |
| **`theoreticalDailyPct`**        | `100 / totalDays` (ex. 3,33 % / jour sur 30 j)                |
| **`theoreticalDailyAmount`**     | `quota / totalDays`                                           |
| **`requiredDailyAvgRemaining`**  | `(quota − consumed) / remainingDays` — moyenne cible sur les jours restants |
| `paceDeltaDaily(Pct)`            | Vitesse réelle − vitesse cible (en unité/j et en %/j)         |
| `projectedEndConsumption`        | `(consumed / elapsed) × totalDays` — projection si la vitesse tient |

Cas limites traités : `consumed > quota` → statut `over_quota` ; `remainingDays ≤ 0` → statut `period_ended`.

---

## Skills (connecteurs)

Chaque connecteur implémente `Skill` (`shared/types.ts`) et **doit** retourner un `SkillUsageReport` conforme au format unique du spec § 6 :

```ts
interface Skill {
  id: string;
  label: string;
  provider: Provider;
  requiredSecrets: string[];   // → champs password dans le formulaire, stockés via OS keychain
  requiredParams: string[];    // → champs texte non sensibles (organizationId, projectId, …)
  fetch(ctx: SkillContext): Promise<SkillUsageReport>;
}
```

Connecteurs livrés :

- `electron/skills/cursor.ts` — squelette + emplacement pour le call HTTP réel.
- `electron/skills/claude.ts` — squelette pour l'Admin API Anthropic.
- `electron/skills/openai.ts` — squelette pour l'Admin API OpenAI.
- `electron/skills/generic.ts` — connecteur de démo qui renvoie une réponse normalisée vide (utile comme template).

Chaque appel est journalisé dans la table `skill_runs` (id, ok, error, JSON brut) — affiché plus tard dans une vue logs (à venir).

### Ajouter un nouveau provider

1. Créer `electron/skills/monfournisseur.ts` qui exporte `const monfournisseurSkill: Skill`.
2. L'ajouter au tableau `SKILLS` dans `electron/skills/index.ts`.
3. La skill apparaît immédiatement dans le formulaire de création de compte.

---

## Sécurité

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (préload nécessaire) — pas d'accès Node depuis le renderer.
- Les secrets ne sont jamais lus côté renderer ; le main les déchiffre **au moment** de l'appel skill et les passe au connecteur.
- Si `safeStorage.isEncryptionAvailable()` est `false` (Linux sans libsecret), `setSecret` rejette plutôt que d'écrire en clair.
- Le fichier SQLite et `secrets.json` vivent dans `app.getPath('userData')` (path natif par OS).

---

## Tests

```bash
npm run test
```

Couverture actuelle (15 tests) :

- `reduceConsumed` : empty, latest cumulative, deltas après cumulative, reset après nouveau cumulative, hors-période ignoré.
- `computeAccountState` : delta linéaire, indicateurs spec, over_quota, period_ended, tolérance "on_track".
- `resolvePeriod` : weekly anchor, monthly anchor, monthly clamp jour 31, yearly clamp 29/02, custom 14 j.

---

## Migration vers Tauri (optionnel)

L'architecture sépare strictement le code partagé (`shared/`) du code spécifique main process (`electron/`). Pour migrer :

1. `cargo create-tauri-app` à côté.
2. Réimplémenter `Storage`, `SecretsStore`, et les handlers IPC en Rust (`tauri::command`).
3. Garder `shared/` et `src/` tels quels — la signature de `window.api` est identique côté Tauri (`window.__TAURI__.invoke`) à un wrapper près.

---

## Roadmap (post-MVP)

- Profils de consommation idéale non-linéaires (front-load / back-load).
- Code-signing + GitHub Releases pour activer les mises à jour automatiques (`MISTER_QUOTA_AUTO_UPDATE=1` côté runtime ; voir `electron/updater.ts`).
- OAuth pour Anthropic / OpenAI quand les fournisseurs publient leurs flows (`electron/skills/oauth.ts` est prêt).

### Déjà livré (waves 1 → 6)

| | |
|---|---|
| **Wave 1** | ESLint + Prettier, GitHub Actions CI (Node 20.x / 22.x, lint + typecheck + test + build + e2e), tests d'intégration `Storage`. |
| **Wave 2** | Schema-versioning du `SkillUsageReport`, projection par régression linéaire (`projectedEndConsumptionRecent`, `projectedExhaustionDate`), comparaison inter-périodes (`previous`, `history`). |
| **Wave 3** | `Account.tags`, `syncIntervalMinutes`, `alertThresholdsPct` ; migration SQLite v2 forward-only ; tag chips + budget € agrégé sur le dashboard. |
| **Wave 4** | Store Zustand, toaster custom, `ConfirmDialog`, `ErrorBoundary`, skeletons de chargement ; remplacement de tous les `alert()` / `confirm()` natifs. |
| **Wave 5** | Import CSV (header-detection + erreurs par ligne), évaluateur d'alertes OS Notifications avec anti-spam intra-période, scheduler par compte, tray icon avec menu trié. |
| **Wave 6** | `fetchWithRetry` (timeout + backoff exponentiel + Retry-After), Playwright e2e en mode preview-shim, scaffolds `electron-updater` (env-gated) et `runPkceFlow`. |

Licence : MIT.
