# Mister Quota

Application desktop multiplateforme (Windows / macOS / Linux) pour suivre la consommation de plusieurs comptes IA (Cursor, Claude, OpenAI, …), avec affichage de l'**avance / retard** par rapport à la consommation idéale jusqu'à la prochaine date d'anniversaire.

> **État réel de la collecte automatique.** Trois connecteurs appellent vraiment une API : OpenAI, Claude et Cursor. Ceux de Claude et de Cursor lisent des **API d'administration** : il faut une organisation Anthropic (clé Admin) ou une équipe Cursor (clé d'administration d'équipe). Un abonnement individuel — Claude Pro, Cursor Pro… — n'y a pas accès et se saisit **à la main**. Le modèle `generic` reste un squelette, et l'application le dit à l'écran (formulaire, carte, journal). Voir « Skills (connecteurs) ».

---

## Choix techniques

| Aspect             | Choix                                                     | Pourquoi                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime desktop    | **Electron** + Vite + React + TypeScript                  | Le spec listait Tauri en défaut ; faute de toolchain Rust sur la machine de scaffolding, Electron a été retenu (option n° 2 du spec). La structure reste portable vers Tauri (cf. § "Migration vers Tauri" plus bas).                       |
| Stockage           | **SQLite via `sql.js`** (WASM, pas de native dep)         | Conforme à l'exigence "SQLite", installable partout sans Visual Studio C++ ni `node-gyp`. Migrations forward-only.                                                                                                                          |
| Secrets (API keys) | **Electron `safeStorage`** → Keychain / DPAPI / libsecret | Conforme à l'exigence "chiffrés localement via OS keychain".                                                                                                                                                                                |
| Dates / TZ         | `date-fns` + `@date-fns/tz`                               | Calcul de période robuste aux fuseaux et aux mois courts (clamp 31 → 28/30). `@date-fns/tz` et non `date-fns-tz` : son `TZDate` PORTE son fuseau, là où le second rendait une `Date` que `date-fns` replaçait dans le fuseau de la machine. |
| Tests              | `vitest` + `@playwright/test`                             | Vitest sur le domaine, le stockage et le format de sauvegarde ; Playwright sur l'interface, en mode _preview shim_ (sans Electron empaqueté).                                                                                               |

### Socle famille

L'app consomme `@mister-guiiug/dev-pwa-config` **sans monter la stack PWA du socle**
(React 19, Vite 8, Vitest 4, ESLint 9) : seuls ses modules indépendants du framework
sont utilisés, d'où `legacy-peer-deps=true` dans `.npmrc`.

Elle importe aussi **`components.css`**, l'habillage des composants `/react`, alors
qu'elle n'a **pas Tailwind** — ce qui était jusqu'ici la raison de s'en passer. La
feuille ne contient aucune directive Tailwind, tous ses `var()` ont un repli et tous
ses sélecteurs sont portés par `[data-dwc=…]` : elle ne peut donc toucher aucun
élément existant. Les quinze jetons `--dwc-*` sont câblés sur la palette de
`src/styles.css`, qui n'est pas « layered » et l'emporte donc sur
`@layer components` sans `!important` — les reprises d'identité (pile de
notifications en bas à droite) sont regroupées en fin de fichier.

Composants pris au socle : `ObservabilityBoundary` (`src/App.tsx`), `ConfirmDialog`
(derrière la file promise de `src/components/ConfirmDialog.tsx`), `ToastViewport`
(`src/components/Toaster.tsx`, la file restant dans `src/toast.ts` parce que
`store.ts` notifie hors de React).

---

## Démarrage rapide

Prérequis : Node 20+ (testé avec 25.2). Aucun toolchain natif requis.

```bash
npm install
npm run test            # 144 tests (domaine, stockage, sauvegarde, connecteurs)
npm run e2e             # 9 tests Playwright sur l'interface
npm run build           # build du renderer (Vite → dist/) + budget de bundle
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
  - **`Electron: Main + Renderer`** _(compound — recommandé)_ : compile electron, démarre Vite en arrière-plan, lance Electron avec `--remote-debugging-port=9223`, puis attache Chrome au renderer. Breakpoints fonctionnels dans `electron/*.ts` **et** `src/**/*.tsx`.
  - **`Electron: Main`** seul — debug du process principal uniquement.
  - **`Electron: Renderer (attach)`** seul — attache à une instance Electron déjà démarrée (port 9223).
  - **`Vitest: current file`** / **`Vitest: all`** — debug d'un test ou de toute la suite.

> Source maps activées (`electron/tsconfig.json` → `sourceMap: true`) — les breakpoints pointent sur le TS d'origine.

> Le mode `npm run dev` (Vite seul, sans Electron) lance l'UI dans le navigateur avec un _preview shim_ en mémoire — utile pour démonstration et pour itérer sur l'UI sans Electron.

---

## Architecture

```
mister-quota/
├── shared/                ← code partagé renderer ↔ main (sans dépendance UI)
│   ├── types.ts           ← tous les types domaine (Account, UsageEntry, AccountState, Skill…)
│   ├── period.ts          ← résolution PeriodRule → [start, end) (TZ-aware)
│   ├── calc.ts            ← fonctions pures de calcul (testées)
│   ├── collection.ts      ← diagnostic « ce compte peut-il collecter ? » (lit Skill.implemented)
│   ├── backup.ts          ← format de sauvegarde : construction, validation, export CSV
│   └── ipc.ts             ← contrat IPC typé entre renderer et main
├── electron/              ← processus principal Electron (Node)
│   ├── main.ts            ← bootstrap + handlers IPC
│   ├── preload.ts         ← expose window.api typé via contextBridge
│   ├── db.ts              ← Storage SQLite (sql.js) + migrations + replaceAll
│   ├── restore.ts         ← restauration : valider → confirmer → écrire
│   ├── secrets.ts         ← SecretsStore (safeStorage)
│   ├── log.ts             ← Logger fichier rotatif
│   └── skills/            ← connecteurs (cursor, claude, openai, generic) + common.ts
├── src/                   ← renderer React
│   ├── App.tsx            ← navigation 5 vues + sauvegarde / restauration
│   ├── store.ts           ← store Zustand (états, relevés, registre des connecteurs)
│   ├── views/
│   │   ├── Dashboard.tsx  ← liste des comptes avec barre de progression et indicateurs
│   │   ├── AccountForm.tsx← création / édition (CRUD comptes + secrets)
│   │   ├── AccountDetail.tsx ← courbe réel vs idéal + relevés + sync now
│   │   └── SyncLog.tsx    ← journal des exécutions de connecteurs (table skill_runs)
│   ├── format.ts          ← helpers d'affichage (unités, %, dates)
│   ├── previewShim.ts     ← backend in-memory pour le mode "vite dev" sans Electron
│   └── styles.css         ← thème sombre simple
├── tests/
│   └── calc.test.ts       ← vérifie reduceConsumed, computeAccountState, resolvePeriod
└── e2e/                   ← Playwright, contre le renderer en mode preview-shim
```

> Les tests unitaires vivent à côté de ce qu'ils couvrent (`*.test.ts` dans `shared/`,
> `electron/` et `src/`) ; `tests/` ne contient que la suite de calcul historique.

### Flux d'une saisie

1. L'utilisateur ouvre **AccountDetail → + Saisie manuelle** ou clique **Synchroniser maintenant**.
2. Le renderer appelle `window.api.insertEntry(...)` ou `window.api.syncNow(...)` (contextBridge).
3. Le main process écrit dans SQLite (`entries`) via `Storage`.
4. Le calcul `computeAccountState` agrège les entries de la période courante (`reduceConsumed`) et renvoie l'objet `AccountState` riche en indicateurs.
5. Le dashboard / la vue détail re-rend avec les nouvelles valeurs.

---

## Indicateurs calculés (spec § 4.4)

Pour chaque compte, `computeAccountState` retourne :

| Indicateur                      | Formule                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `consumed`                      | Agrégat des entries (mix cumulative + delta)                                       |
| `idealToDate`                   | `quota × (elapsed / total)`                                                        |
| `delta` / `deltaPct`            | `consumed − idealToDate` ; `delta / quota × 100`                                   |
| `status`                        | `ahead` / `on_track` / `behind` / `over_quota` / `period_ended` selon la tolérance |
| **`theoreticalDailyPct`**       | `100 / totalDays` (ex. 3,33 % / jour sur 30 j)                                     |
| **`theoreticalDailyAmount`**    | `quota / totalDays`                                                                |
| **`requiredDailyAvgRemaining`** | `(quota − consumed) / remainingDays` — moyenne cible sur les jours restants        |
| `paceDeltaDaily(Pct)`           | Vitesse réelle − vitesse cible (en unité/j et en %/j)                              |
| `projectedEndConsumption`       | `(consumed / elapsed) × totalDays` — projection si la vitesse tient                |

Cas limites traités : `consumed > quota` → statut `over_quota` ; `remainingDays ≤ 0` → statut `period_ended`.

---

## Skills (connecteurs)

Chaque connecteur implémente `Skill` (`shared/types.ts`) et **doit** retourner un `SkillUsageReport` conforme au format unique du spec § 6 :

```ts
interface Skill {
  id: string;
  label: string;
  provider: Provider;
  requiredSecrets: string[]; // → champs password dans le formulaire, stockés via OS keychain
  requiredParams: string[]; // → champs texte non sensibles, à renseigner (projectId, …)
  optionalParams?: string[]; // → champs texte non sensibles que le connecteur sait laisser vides
  implemented: boolean; // → false = squelette : ne parle à aucune API, l'UI le dit
  fetch(ctx: SkillContext): Promise<SkillUsageReport>;
}
```

`implemented` est la pièce importante : **le connecteur déclare lui-même s'il collecte
vraiment quelque chose**. Le drapeau traverse le pont IPC et c'est lui — jamais une liste
de noms codée en dur — que lisent le formulaire de compte, la carte du tableau de bord et
le journal des synchronisations. Le processus principal, lui, refuse d'appeler un
squelette et inscrit le refus dans `skill_runs` : le jour où un appel HTTP est écrit, il
suffit de passer le drapeau à `true` pour que les avertissements disparaissent partout.

Connecteurs livrés :

| Fichier                      | État                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/skills/openai.ts`  | **Opérationnel** — appelle l'Admin API OpenAI via `fetchWithRetry`. Le champ agrégé peut ne pas correspondre à l'unité du quota, d'où `confidence: 'estimated'`. |
| `electron/skills/cursor.ts`  | **Opérationnel** — lit l'API d'administration d'équipe de Cursor (dépense, requêtes, jetons) via `fetchWithRetry`. Voir ci-dessous.                              |
| `electron/skills/claude.ts`  | **Opérationnel** — lit l'API Usage & Cost d'Anthropic (jetons, coûts) via `fetchWithRetry`. Voir ci-dessous.                                                     |
| `electron/skills/generic.ts` | **Modèle** à copier pour écrire un vrai fournisseur. Ne collecte rien (et ne doit pas être lancé : son `consumed: 0` deviendrait la référence de la période).    |

Chaque appel — y compris un refus de squelette — est journalisé dans la table `skill_runs`
(id, ok, error, JSON brut) et affiché par **« Journal des syncs »** (`src/views/SyncLog.tsx`),
qui étiquette les connecteurs squelettes et les liste en tête.

### Claude et Cursor : clé, plan, unités

Les deux connecteurs lisent une **API d'administration** : la clé à créer n'est pas une clé
d'API ordinaire, et un abonnement individuel n'y a pas accès. Ce qu'ils font de la même façon
(`User-Agent`, centimes, jours UTC, messages d'erreur, rapport) vit dans
`electron/skills/common.ts`. Leurs messages d'erreur disent quoi corriger — mauvais type de clé
(401/403), plan ou endpoint indisponible (404), limite de débit (429) — et ne recopient jamais la
clé.

#### Claude (Anthropic) — API Usage & Cost

- **Clé** (champ `adminApiKey`) : une clé **Admin d'organisation**, `sk-ant-admin01-…`. Seul un
  membre de rôle _admin_ peut la créer, dans
  [Console › Settings › Admin keys](https://platform.claude.com/settings/admin-keys). Une clé
  d'API de workspace — la clé ordinaire — est refusée.
- **Plan** : une organisation de la Console Claude. L'API n'existe pas pour les comptes
  individuels, et Claude Enterprise (claude.ai) passe par une autre API, que ce connecteur ne lit
  pas. Un abonnement Claude Pro ou Max se suit à la main.
- **Paramètres** : aucun. L'ancien `organizationId` n'est plus demandé ; un compte qui le porte
  encore se synchronise normalement, le paramètre est ignoré.

| Unité du compte   | Ce que mesure le relevé                                                                                                                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tokens            | `GET /v1/organizations/usage_report/messages` : toutes les catégories de jetons — entrée non cachée, écriture de cache (1 h et 5 min), lecture de cache, sortie. Les recherches web ne sont pas des jetons.                                                                                   |
| Devise            | `GET /v1/organizations/cost_report` : le coût, en **dollars** (l'API compte en centimes d'USD). Sur un compte tenu dans une autre devise, le montant reste en dollars, **non converti**, et le relevé est `estimated`. Les coûts Priority Tier n'y figurent pas (limite documentée de l'API). |
| Requêtes, Crédits | Non fournis par l'API : la synchronisation échoue avec un message explicite, jamais un chiffre de remplacement.                                                                                                                                                                               |

#### Cursor — API d'administration d'équipe

- **Clé** (champ `apiKey`) : une clé d'API **d'administration d'équipe**, qu'un administrateur
  crée dans le tableau de bord de l'équipe ([cursor.com/dashboard](https://cursor.com/dashboard)
  › API Keys), avec la portée `admin:*` que la documentation de Cursor exige pour cette API —
  même si le connecteur ne fait que lire.
- **Plan** : une équipe. La documentation de Cursor range l'API d'administration sous
  « Enterprise teams » et réserve une partie de ses données au plan Enterprise : un 403 le
  signale.
- **Paramètre facultatif** : `email`, pour ne compter qu'un membre de l'équipe (vide : toute
  l'équipe).

| Unité du compte | Ce que mesure le relevé                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Devise          | `POST /teams/spend` : la dépense du **cycle de facturation en cours** (`overallSpendCents`, à défaut `spendCents`), en dollars. Si le cycle ne s'ouvre pas le même jour que la période du compte, le relevé est `estimated` et sa référence donne la date d'ouverture du cycle. Une adresse `email` absente de l'équipe est une erreur, pas un zéro. |
| Requêtes        | `POST /teams/daily-usage-data` : les requêtes facturables (`subscriptionIncludedReqs + usageBasedReqs + apiKeyReqs`), jour par jour, par tranches de 30 jours au plus. Cursor agrège ces chiffres à l'heure : synchroniser plus d'une fois par heure n'apporte rien.                                                                                 |
| Tokens          | `POST /teams/filtered-usage-events` : les jetons (entrée, sortie, écriture et lecture de cache) de chaque événement, sur 30 pages de 1 000 événements au plus — au delà, le total est partiel et `estimated`. Un appel qui n'est pas facturé au jeton ne porte pas de compteur : il est omis, et le relevé devient `estimated`.                      |
| Crédits         | Non fourni par l'API : erreur explicite.                                                                                                                                                                                                                                                                                                             |

#### Exact ou estimé

Chaque relevé porte `confidence: 'exact' | 'estimated'`, et sa référence (`raw.reference`,
visible dans le JSON du journal) dit pourquoi il est estimé :

- **Fuseau** : les rapports d'Anthropic et le décompte quotidien de Cursor rangent leurs chiffres
  en jours UTC. Une période qui ne s'ouvre pas à minuit UTC — tout fuseau autre qu'UTC — est
  comptée sur les jours UTC les plus proches : le total est décalé de l'écart de fuseau.
- **Devise** : un montant en dollars posé sur un compte tenu dans une autre devise.
- **Cursor** : cycle de facturation décalé de la période, plafond de pages atteint, événements
  sans compteur de jetons.

### Ajouter un nouveau provider

1. Créer `electron/skills/monfournisseur.ts` qui exporte `const monfournisseurSkill: Skill`. Ses paramètres non secrets vont dans `requiredParams`, ou dans `optionalParams` s'il sait s'en passer : le formulaire affiche les deux.
2. Le déclarer `implemented: false` tant que l'appel HTTP n'est pas écrit — l'interface préviendra l'utilisateur toute seule.
3. L'ajouter au tableau `SKILLS` dans `electron/skills/index.ts`.
4. La skill apparaît immédiatement dans le formulaire de création de compte.
5. Le mode « vite dev » a son propre registre (`src/previewShim.ts`) : y refléter les mêmes drapeaux.

---

## Sauvegarde et restauration

**Sauvegarder (JSON)** écrit un fichier qui se déclare (`app`, `formatVersion`,
`schemaVersion`) et que **Restaurer une sauvegarde** sait relire : comptes, règles de
période, tags, seuils d'alerte et tous les relevés. **Exporter (CSV)** reste un vidage
pour tableur — il perd les réglages et ne se réimporte pas (au delà des relevés d'un
compte, via « ↑ Importer CSV » dans la vue détail).

La restauration suit un ordre qui est la fonctionnalité elle-même (`electron/restore.ts`) :

1. **Valider.** Le fichier d'une autre application, ou écrit avec un schéma de base
   inconnu, est refusé **avant la première écriture** : rien n'est effacé, et la
   confirmation n'est même pas demandée. Comptes et relevés sont reconstruits champ par
   champ à partir d'une liste blanche — ce que le fichier contient en plus est jeté.
2. **Confirmer.** Une base non vide n'est jamais remplacée sans un oui explicite, qui
   annonce ce qu'il emporte (y compris le journal des synchronisations).
3. **Écrire**, en une transaction : un échec en cours de route laisse la base intacte.

**Les clés d'API ne sont jamais dans une sauvegarde.** Elles vivent dans le trousseau du
système et n'en sortent pas : l'export ne les lit pas, l'import n'en écrit aucune, et une
restauration élague celles des comptes qui disparaissent. Après restauration sur une autre
machine, les secrets sont donc à ressaisir. `electron/backup-secrets.test.ts` le vérifie
sur les deux formats.

---

## Sécurité

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (préload nécessaire) — pas d'accès Node depuis le renderer.
- Les secrets ne sont jamais lus côté renderer ; le main les déchiffre **au moment** de l'appel skill et les passe au connecteur.
- Si `safeStorage.isEncryptionAvailable()` est `false` (Linux sans libsecret), `setSecret` rejette plutôt que d'écrire en clair.
- Le fichier SQLite et `secrets.json` vivent dans `app.getPath('userData')` (path natif par OS).
- **Aucune clé ne sort par l'export, aucune n'entre par l'import** — export et import ne connaissent que les comptes et les relevés, dont les champs sont recopiés un par un depuis une liste blanche. Une clé posée par accident sur un objet en mémoire ne sortirait pas davantage.

---

## Tests

```bash
npm run test
```

Couverture actuelle (144 tests unitaires, 9 tests Playwright) :

- `reduceConsumed` : empty, latest cumulative, deltas après cumulative, reset après nouveau cumulative, hors-période ignoré.
- `computeAccountState` : delta linéaire, indicateurs spec, over_quota, period_ended, tolérance "on_track".
- `resolvePeriod` : weekly anchor, monthly anchor, monthly clamp jour 31, yearly clamp 29/02, custom 14 j.
- `Storage` : aller-retour SQLite, cascade, persistance, migrations, `replaceAll` transactionnel, verrou de version de schéma.
- `diagnoseCollection` : ce qu'annonce un compte contre ce que le connecteur sait faire ; deux tests interdisent une liste de noms en dur.
- `parseBackup` / `buildBackup` : aller-retour, refus d'un fichier étranger ou d'un schéma inconnu, liste blanche, sauvegarde v1 relue.
- **`backup-secrets`** : aucune clé d'API dans l'export (JSON et CSV), aucune écrite à l'import, ordre valider → confirmer → écrire.
- **Connecteurs Claude et Cursor**, sur un `fetch` simulé — aucun appel réel : en-têtes et authentification, pagination, tranches de 30 jours, centimes → dollars, chaque unité, cas `estimated` (fuseau, devise, cycle, plafond), erreurs 401/403/404/429/réseau sans fuite de la clé, rétrocompatibilité d'`organizationId`.
- `fetchWithRetry`, `evaluateAlerts`, file de notifications.

```bash
npm run e2e     # Playwright sur le renderer en mode preview-shim (sans Electron)
```

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

|            |                                                                                                                                                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wave 1** | ESLint + Prettier, GitHub Actions CI (Node 20.x / 22.x, lint + typecheck + test + build + e2e), tests d'intégration `Storage`.                                                                                                        |
| **Wave 2** | Schema-versioning du `SkillUsageReport`, projection par régression linéaire (`projectedEndConsumptionRecent`, `projectedExhaustionDate`), comparaison inter-périodes (`previous`, `history`).                                         |
| **Wave 3** | `Account.tags`, `syncIntervalMinutes`, `alertThresholdsPct` ; migration SQLite v2 forward-only ; tag chips + budget € agrégé sur le dashboard.                                                                                        |
| **Wave 4** | Store Zustand, toaster custom, `ConfirmDialog`, `ErrorBoundary`, skeletons de chargement ; remplacement de tous les `alert()` / `confirm()` natifs. _(Les trois composants sont depuis passés au socle — voir « Socle famille ».)_    |
| **Wave 5** | Import CSV (header-detection + erreurs par ligne), évaluateur d'alertes OS Notifications avec anti-spam intra-période, scheduler par compte, tray icon avec menu trié.                                                                |
| **Wave 6** | `fetchWithRetry` (timeout + backoff exponentiel + Retry-After), Playwright e2e en mode preview-shim, scaffolds `electron-updater` (env-gated) et `runPkceFlow`.                                                                       |
| **Wave 7** | `Skill.implemented` — les connecteurs déclarent s'ils collectent, l'interface le répète et le main refuse d'appeler un squelette ; sauvegarde JSON restaurable (valider → confirmer → transaction), sans jamais toucher au trousseau. |
| **Wave 8** | Connecteurs Claude (API Usage & Cost) et Cursor (API d'administration d'équipe) opérationnels ; paramètres facultatifs de connecteur (`Skill.optionalParams`) saisis dans le formulaire.                                              |

Licence : MIT.
