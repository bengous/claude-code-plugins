# Audit de l'organisation du code

État mesuré le 2026-08-21 sur `dev` = `bc9a64a` (un commit de style au-dessus du merge de la PR #45, `39b182a`).

Addendum au moment du commit : `dev` a avancé de 3 commits (`29a8fa9`, `9544695`, `52b84e9`).
`9544695` supprime `.claude/rules/` en entier : les constats sur `script-patterns.md` et `hook-patterns.md`
sont réglés par suppression. Le « `bun test` # all suites » faux survit dans `.claude/CLAUDE.md:19`.
Le reste de l'audit est inchangé.
Chaque affirmation historique cite un SHA. Chaque décompte vient d'une commande reproduite sur ce worktree.
L'inventaire et l'histoire ont été contre-vérifiés par un agent en contexte neuf : 26 faits confirmés, 9 corrigés avant rédaction.

Volumétrie globale : 39 fichiers `.ts` suivis, 26 `.sh`, 14 exécutables sans extension à shebang (10 bash, 4 bun),
16 fichiers `*.test.ts`, 20 plugins dans `.claude-plugin/marketplace.json`.
`bun test` à la racine : 337 tests, 13 fichiers. `bun test scripts` (la commande CI) : 176 tests, 9 fichiers.

---

## 1. Inventaire

`archive/` (4 plugins retirés, 43 fichiers, aucun `plugin.json`, aucune référence entrante hors exclusions volontaires)
et `_docs/` (références scrapées) sont comptés mais exclus des recommandations.

| Zone | Langage | Fichiers code | Lignes | tsconfig | Testé | En CI |
|---|---|---|---|---|---|---|
| `scripts/` (+`lib/`, `__tests__/`) | TS + 1 bash | 10 .ts + `publish-live` | 1 873 + 2 | aucun | 4 fichiers | oui |
| `.claude/hooks/` | TS + sh | 7 .ts + 2 .sh | 1 031 + 61 | aucun | 3 fichiers, **jamais exécutés** | non |
| `.claude/git/` | TS + sh | 1 .ts + 2 .sh | 20 + 41 | aucun | non | non (lefthook seulement) |
| `.claude/scripts/` | bash | 2 | 347 | — | non | non |
| `_shared/claude-cli/` | TS | 11 (+package.json, tsconfig, bunfig, bun.lock) | 1 782 | oui (local) | 4 fichiers, local seulement | non |
| `conductor/` | — | 0 (+package.json, tsconfig, bun.lock) | 0 | couvre 0 fichier | — | — |
| `git-tools/` | bash | 10 | 2 080 | — | `test-scripts.sh` manuel | non |
| `git-worktree/` | bash | 2 | 962 | — | non | non |
| `git-sweep/` | bun sans ext. | 2 + 2 tests | 1 101 + 1 120 | aucun | oui | oui |
| `ship/` | bun sans ext. | 2 + 2 tests | 706 + 1 168 | aucun | oui | oui |
| `plugin-cache-sync/` | bash | 2 + 1 test .ts | 539 + 194 | aucun | oui | oui |
| `session-archive/` | TS + sh | 1 .ts + 1 .sh + 1 test | 892 + 9 + 625 | aucun | oui, local seulement | non |
| `claude-settings-manager/` | bash | 1 | 1 494 | — | non | non |
| `agents-bridge/` | bash | 3 | 226 | — | non | non |
| `claude-meta-tools/` | sh + js | 2 .sh + 1 .js | 130 + 519 | — | non | non |
| `orchestration/` | js | 1 | 241 | — | non | non |
| `plan-review/` | py + js | 1 .py + 1 .js | 217 + 269 | — | non | non |
| `design-studio/` | TS | 1 | 209 | aucun | non | non |
| `clean-comments/` | TS | 1 | 327 | aucun | non | non |
| `goalify/`, `software-craft/`, `context-management/` | md | 0 script | — | — | — | — |
| `docs/` | md | 39 (4 racine + 35 `docs/hooks/`) | 4 625 | — | — | — |
| `_docs/` | sh + py + md | 6 .sh + 4 .py + 110 fichiers scrapés commités | 1 194 + 773 | — | non | non |
| `archive/` | ts + sh + py | 1 + 1 + 6 | ~1 000 | — | non | non |

Points de couverture, mesurés :

- **Tests.** 16 fichiers de test sur disque. `bun test` racine en lance 13 (Bun saute les dossiers en point,
  vérifié empiriquement : un fichier de test sous `.hidden/` n'est pas collecté). La CI lance `bun test scripts`
  (`.github/workflows/ci.yml:28`), soit 9 fichiers : le filtre matche tout chemin contenant `scripts`
  (`scripts/` 4, `git-sweep/scripts` 2, `ship/scripts` 2, `plugin-cache-sync/scripts` 1).
  Jamais exécutés nulle part : les 3 de `.claude/hooks/`, c'est-à-dire les tests des hooks qui gardent le repo.
  Nommés explicitement, ils passent : `bun test ./.claude/hooks/*.test.ts` → 41 pass, 212 ms.
- **Type-check.** Deux `tsconfig.json` : `_shared/claude-cli/` (couvre ses 11 .ts) et `conductor/`
  (`include: ["hooks/**/*.ts", "scripts/**/*.ts"]` — 0 fichier existant). 28 des 39 .ts ne sont couverts par aucun.
  Le script `typecheck` de `_shared/claude-cli/package.json` échoue : `mise ERROR No version is set for shim: tsc`.
  Ni lefthook ni la CI ne l'appellent.
- **Lint/format.** Aucune config nulle part : pas de `biome.json(c)`, `.oxlintrc.json`, `eslint.config.js`,
  `.prettierrc`, `.editorconfig`, `.shellcheckrc` à la racine. Le seul `bunfig.toml` est dans `_shared/claude-cli/`.
- **Îlots npm.** Trois : racine (`package.json` + `bun.lock`, dépendance unique `yaml`), `_shared/claude-cli/`, `conductor/`.

---

## 2. Histoire

Chronologie reconstruite depuis `git log --diff-filter=A`, `git log -S`, `git show`.

**2025-10-18 — `6314020`** : premier étage, le scraper de docs (`_docs/`). Plus jamais touché depuis
`acf9c14` (même jour). C'est la couche archéologique du repo.

**2025-11-15 → 2025-12-15 — `e274da5`, `6c7ca74`, `a319959`** : CLAUDE.md est éclaté en fichiers de référence,
puis `.claude/rules/` est créé, dont `scripts/script-patterns.md` (335 lignes, `paths: "**/scripts/**"`).
Ce document prescrit du bash de bout en bout (`#!/usr/bin/env bash` + `set -euo pipefail`, état JSON via `jq`,
libs `source`) et n'a **jamais été retouché depuis le 2025-12-15**. Tout le TypeScript du repo lui est postérieur.

**2025-12-31 — `306154d`** : `validate-marketplace` converti en bun. Premier TypeScript à la racine ;
la doctrine bash de `script-patterns.md` est contredite 16 jours après sa rédaction.

**2026-01-23 — `9a5eb98` (01:04) et `6a58826` (01:53)** : création de `_shared/claude-cli/` (855 insertions :
`index.ts`, `hooks.ts`, `presets.ts`, `types.ts`, `test-spawn.ts`) puis de ses configs (package.json, tsconfig,
bunfig) en même temps que des hooks TypeScript de `conductor/`. Point corrigé par la contre-vérification :
les hooks conductor n'importaient **pas** le SDK (`conductor/hooks/lib/hooks.ts:4-5` dans `6a58826` :
« Self-contained within conductor for marketplace portability »). Le SDK est né sans consommateur.

**2026-01-24 16:00 — `f56b2e6`** : conductor migre vers l'orchestration par Task et supprime
`conductor/hooks/` et `conductor/scripts/` (~39 h après leur création). Le plugin garde `package.json`,
`tsconfig.json` et `bun.lock`, qui ne couvrent plus aucun fichier depuis cette date.

**2026-02-06 — `6f23394`** : `session-archive/` entre dans le repo. Outil personnel : hors de
`marketplace.json`, README avec chemins `~/projects/claude-plugins/` aujourd'hui périmés
(le repo vit dans `~/Work/claude-code-plugins`).

**2026-03-11 — la journée qui a créé la duplication de hooks**, en quatre commits :

| Heure | SHA | Fait |
|---|---|---|
| 00:10 | `bacccbb` | Copie les hooks du projet « recall » vers `_shared/claude-cli/hooks/` comme « reusable library examples » : versions génériques, configurables par `LINT_SCOPE`/`LINTABLE_EXTS`, avec 69 tests. |
| 01:00 | `f6f75f1` | Ajoute `guard-main-branch.ts` au même endroit et l'enregistre dans settings + lefthook. |
| 18:29 | `5e77d1e` | Gitignore `_hooks-lib/` — message : « Separate git repo for the claude-hooks command-hook framework ». `_hooks-lib/` n'a **jamais été commité sur aucune branche** (`git log --all -- _hooks-lib` vide) : c'était un repo git imbriqué, volontairement non suivi. |
| 18:44 | `1fbd81e` | Ajoute une **seconde** copie des mêmes hooks recall dans `.claude/hooks/`, « adapted for this repo's structure » : chemin en dur `_hooks-lib`, FIXME assumé. C'est cette copie qui est enregistrée dans `settings.json`. |

Deux copies du même code source, nées le même jour, l'une générique et l'autre spécifique, toutes deux conservées.

**2026-04-01 — `2ab3ffa` (ship), `d6153c9` (git-sweep)** : premiers exécutables Bun sans extension `.ts`.
`script-patterns.md`, figé 3,5 mois plus tôt, ne les mentionne pas.

**2026-04-28 — `ca194c2`** : la copie `.claude/hooks/` de `format-and-lint` reçoit `updatedToolOutput`
et 117 lignes de tests ; la copie `_shared` n'est pas touchée. C'est le commit de divergence
(diff aujourd'hui : 138 lignes sur le hook, 166 sur le test).

**2026-06-15 → 2026-08-21 — `a964829` (CI), `f53c543` (plan-reference-audit), `eed969f` (guard-settings-json)** :
l'outillage récent est actif et cohérent ; il s'empile sur les couches précédentes sans les nettoyer.

Lecture d'ensemble : chaque couche est cohérente à sa date. Le slop n'est pas dans les couches, il est dans
leur accumulation — la règle « Replace, don't accumulate » du repo n'a pas été appliquée aux hooks (2 copies),
aux configs npm (3 îlots), ni à la doctrine scripts (bash figée sous un repo devenu moitié TypeScript).

---

## 3. Mort ou faux

| Artefact | Prétend | Fait | Preuve |
|---|---|---|---|
| `.claude/hooks/format-and-lint.ts` (enregistré `PostToolUse` sur `Edit\|Write`, timeout 30 s) | Formater et linter chaque fichier édité | Sort en `ALLOW` à chaque appel : `isLintable()` exige le préfixe `_hooks-lib/src/` et `_hooks-lib/` est absent du disque | `:38`, `settings.json:63-74`, `.gitignore:73`, `5e77d1e` |
| `_shared/claude-cli/` hors `hooks/` (813 l. : `spawn`, 6 presets, 4 factories, types) | SDK réutilisable pour hooks | Zéro import externe de `spawn`, des presets ou des factories. Seul import de code du dossier : `.claude/git/block-commit-to-main.ts:11`, vers `hooks/guard-main-branch.ts` | `grep -rn createPreToolUseHook\|withPreset` : 0 hit hors `_shared` |
| Duplication `format-and-lint` | — | Deux programmes différents (l'un no-op à chemin dur, l'autre générique jamais branché), divergés à `ca194c2` | `diff` : 138 l. (hook), 166 l. (test) |
| Duplication `guard-destructive` | — | Quasi identiques (diff 27 l. : docstring + origine de `HOOK_EXIT`). Nuance : la copie `_shared` n'est **pas** morte, `guard-main-branch.ts:29` importe ses `parseHookInput`/`stripStringLiterals`. La copie `.claude/hooks/` est le hook enregistré (`settings.json:30`) — et n'a pas de test ; le test (214 l.) couvre l'autre copie | `diff -u`, `settings.json:30,36` |
| `conductor/package.json` + `tsconfig.json` + `bun.lock` | Type-check et tests du plugin | Couvrent 0 fichier depuis `f56b2e6` (2026-01-24) | `find conductor -name '*.ts'` vide |
| `git-tools/scripts/rebase/` (4 fichiers, 1 126 l.) + `/rebase` | Rebase interactif « AI-powered » | Meurt à `rebase:367` : `((idx++))` avec `idx=0` sous `set -e` sort en statut 1, avant même l'affichage du plan (autres sites fatals : `lib/ui.sh:115,120,127,131` sur d'autres compteurs, `lib/conflict.sh:100`, `lib/ai.sh:138`). `MAIN_REPO` déduit du répertoire du **plugin**, pas du repo utilisateur (`rebase:15-20`). L'« IA » est un mock : `ai.sh:38` « mock for now », suggestions par `sed`. Commit unique `bdb8821` (2025-10-13) | comportement `((idx++))` reproduit en shell jetable |
| `.claude/scripts/sync-anthropic-skills` (298 l.) + `/sync-official-skills` | Vendoriser les skills officielles | Cibles `$HOME/projects/claude-plugins/...` (`:6`, `:15`) inexistantes sur cette machine : warn puis `return 0`, rien n'est vendorisé. La commande (`.claude/commands/sync-official-skills.md:15,40`) invoque le même chemin mort et échoue avant le script | `ls ~/projects/claude-plugins` échoue |
| `settings-manager` sous-commande `validate` (`cmd_validate`, `:191`) | Valider `__settings.jsonc` contre le schéma | Télécharge le schéma (`:258`) puis ne l'utilise jamais ; sa liste `validEvents` (`:288`) omet `SessionStart`, que `.claude/__settings.jsonc:29` déclare → rejetterait la config du repo. Dormant : `settings-manager` n'est pas sur le PATH, `settings-sync.sh:18` saute la validation en silence | lecture `:191-303` |
| `.claude/rules/scripts/script-patterns.md` (335 l., `paths: "**/scripts/**"`) | Doctrine des scripts | 100 % bash, zéro mention de TypeScript/Bun, alors que la zone qu'il couvre contient les 4 exécutables Bun et le TS de `scripts/`. Figé depuis `a319959` (2025-12-15) | frontmatter `:2`, `git log` |
| `.claude/CLAUDE.md:9` « `bun test` # all suites » | — | 13/16 fichiers en local, 9/16 en CI, 3 jamais | mesures §1 |
| `.claude/rules/hooks/hook-patterns.md` : « This repository does not currently have production hook examples » | — | `settings.json` enregistre 7 hooks de production | `settings.json:10-75` |
| `software-craft/` | 5 skills | 4 noms livrés en double `commands/*.md` + `skills/*/SKILL.md` (`cli-design`, `excellence-skill-creator`, `iaqi`, `system-architecture`) — violation de la règle « Never ship both under one name » de `.claude/CLAUDE.md` | `ls software-craft/commands software-craft/skills` |
| Gardes `ExitPlanMode` | — | Deux implémentations concurrentes : `plan-review/hooks/preuse-exitplanmode.py` (217 l., Python) et `.claude/hooks/plan-reference-audit.ts` (230 l., TS), logiques différentes | lecture des deux |
| `orchestration/scripts/setup-hooks.js` | Installer les hooks du plugin | Contournement daté « Claude Code v2.0.13 » (`:6`) + chemin en dur `~/.claude/plugins/marketplaces/bengous-plugins/orchestration` (`:23`), contre la règle « No hardcoded paths ». Dupliqué par `plan-review/scripts/setup-plan-review.js` (`:6` : « Follows the pattern from... ») | lecture |
| `_docs/__scraping__/scripts/downloaded/en/` | Sortie de scraper | 110 fichiers commités (109 `.md` + `llms.txt`) : le générateur écrit hors des chemins ignorés (`_docs/.gitignore` n'ignore que `scraped/*` et `references/*`) | `git ls-files \| grep -c 'downloaded/'` = 110 |

Divers, constatés mais secondaires : les 4 fichiers de test bun gardent un fallback chezmoi `executable_*`
jamais pris (`ship/scripts/prep-pr.test.ts:16`, `git-ship.test.ts:10`, `git-clean-audit.test.ts:8`,
`git-clean-apply.test.ts:8`) ; `agents-bridge/scripts/codex:1` et `_docs/__scraping__/scripts/compare-sources.sh:1`
sont les deux seuls `#!/bin/bash` sans `set -euo pipefail` ; `_docs/references/setup.sh:32` utilise `${RED}`
jamais défini sous `set -u` (le chemin d'erreur plante) ; `scripts/publish-live` (2 l.) wrappe
`agent-assets-publish`, binaire de `~/.local/bin` hors repo ; `.claude/git/block-commit-to-main.ts` n'a pas
le bit exécutable (fonctionne car lefthook l'invoque via `bun`) ; `CleanupManifest`/`isOid`/`isValidManifest`
sont dupliqués à l'identique (~45 l.) entre `git-clean-apply:13-92` et `git-clean-audit:93-100,357-393`.

Contrepoint, pour ne pas conclure au slop généralisé : les scripts bun de `git-sweep/` et `ship/` sont le
meilleur code du repo (unions discriminées, erreurs structurées, gardes de destruction, testés) ;
`plugin-cache-sync` est le bash le mieux tenu ; `session-archive.ts` est robuste (verrou, écriture atomique).
La frontière testé/non-testé recoupe presque exactement la frontière TypeScript/bash.

---

## 4. Options

Coûts en fichiers, mesurés sur cet état. Chaque option nomme ce qu'elle supprime.
Les options sont cumulatives : 2 contient 1, 3 contient 2.

### Option 1 — Purge du mort, périmètre inchangé

Supprimer ce qui est prouvé mort ou menteur, sans rien réorganiser d'autre.

| | Détail |
|---|---|
| Coût | ~30 fichiers supprimés (~2 800 l.), 5 déplacés, ~7 édités. Une PR. |
| Supprime | `_shared/claude-cli/` **en entier** après rapatriement de `hooks/guard-main-branch.ts`, `hooks/guard-destructive.ts` et leurs 3 tests vers `.claude/hooks/` (la copie `.claude` de `guard-destructive.ts` est remplacée par la version testée : replace, don't accumulate ; `HOOK_EXIT` défini localement). `.claude/hooks/format-and-lint.ts` + test + son entrée `PostToolUse` dans `__settings.jsonc`. `conductor/{package.json,tsconfig.json,bun.lock}`. `.claude/scripts/sync-anthropic-skills` + `.claude/commands/sync-official-skills.md`. `git-tools/scripts/rebase/` (4 fichiers) + `commands/rebase.md` → `archive/`. `git rm --cached` des 110 fichiers scrapés + correction de `_docs/.gitignore`. |
| Édite | `__settings.jsonc` (2 chemins de hooks), `lefthook.yml`/`block-commit-to-main.ts` (import), `CLAUDE.md:9`, `hook-patterns.md`, README de `git-tools`. |
| Règle | Le hook menteur, le SDK fantôme, le plugin cassé visible, les scrapes commités. |
| Ne règle pas | Type-check absent, lint absent, 4 exécutables invisibles, 3 tests jamais lancés, `script-patterns.md` faux, doublons `software-craft`. |
| Casse | Rien : tout le supprimé est mort, et les deux hooks vivants sont déplacés avec leurs tests. |

### Option 2 — Option 1 + normalisation TypeScript

Un seul monde TypeScript : une config, un type-check, tous les tests en CI.

| | Détail |
|---|---|
| Coût | Option 1 + 4 renommages, ~12 fichiers édités, 1 `tsconfig.json` créé, 2 devDependencies ajoutées. Une PR de plus. |
| Supprime | Les 2 `tsconfig.json` existants → **un seul** à la racine (couvre les 39 .ts). Les îlots npm de `_shared` et `conductor` (déjà partis en option 1) → **un seul** `package.json` racine (`typescript`, `@types/bun` en dev). La doctrine tout-bash de `script-patterns.md` (réécrit court : bash pour la glue < ~150 l., TypeScript testé au-delà, extensions obligatoires). Les 4 fallbacks chezmoi des tests. |
| Renomme | `git-sweep/scripts/git-clean-{audit,apply}`, `ship/scripts/{git-ship,prep-pr}` → `.ts`. Réfs à mettre à jour : ~20 lignes dans 5 fichiers md vivants + 4 constantes de test. `session-archive.ts` prouve que shebang `#!/usr/bin/env bun` + extension coexistent. |
| Branche | `bun x tsc --noEmit` en job lefthook + step CI. CI : `bun test` remplacé par `bun test && bun test ./.claude/hooks/*.test.ts` (vérifié : les 3 fichiers passent, 41 tests, 212 ms) → 16/16 fichiers exécutés. |
| Ne règle pas | Lint/format toujours absents ; qualité bash non contrôlée. |
| Casse | Risque faible : les renommages changent des chemins appelés par des skills md (5 fichiers listés). Le premier `tsc --noEmit` remontera des erreurs dans du code jamais type-checké — volume non mesuré (§7) ; prévoir de corriger ou d'exclure zone par zone. |

### Option 3 — Option 2 + lint et format branchés

L'outillage qualité que `format-and-lint.ts` promettait sans le faire.

| | Détail |
|---|---|
| Coût | Option 2 + 2 fichiers de config, 1 hook réécrit (~60 l.), ~31 corrections shellcheck (mesuré), corrections lint TS non mesurées. |
| Supprime | Rien de plus — mais **remplace** le hook `PostToolUse` mort par une v2 qui pointe la config racine (pas de coexistence v1/v2). |
| Outils | Biome pour TS/JS (déjà la référence du repo : les deux `format-and-lint` l'appellent) ; shellcheck + shfmt pour les 18 `.sh` vivants et 10 bash sans extension. Mesuré : shellcheck = 0 erreur, 24 alertes sur les `.sh` vivants + 7 sur les bash sans extension ; la famille `rebase` seule en porte 48, qui disparaissent avec l'option 1. |
| Branche | Jobs lefthook `pre-commit` (glob `*.sh` → shellcheck ; `*.ts` → biome check) ; 2 steps CI ; hook `PostToolUse` réécrit, scopé d'abord à `scripts/`, `.claude/`, `git-sweep/`, `ship/`. |
| Ne règle pas | Doublons `software-craft`, gardes `ExitPlanMode` concurrents, js/py orphelins (`orchestration`, `plan-review`) — décisions produit, pas outillage. |
| Casse | Friction possible du hook redevenu actif sur du code hétérogène ; d'où le scope initial restreint. |

### Option 4 — Workspaces Bun (chiffrée pour mémoire, rejetée)

Un `package.json` racine avec `workspaces` par plugin à code : ~8 `package.json` créés, lefthook et CI réécrits
par workspace, `bun install` par dossier. Pour 39 fichiers `.ts` (9 576 l.) et **une** dépendance externe
(`yaml`), l'isolation de dépendances ne protège rien. Contraire à `.claude/rules/02-simplicity.md`
(« A 20-line script is better than a 200-line framework »). Rejetée.

---

## 5. Recommandation

Option 3, découpée en deux PR : d'abord la purge (option 1, zéro risque, ~2 800 lignes mortes en moins),
puis normalisation + outillage (options 2+3 ensemble, puisque le tsconfig et le lint touchent les mêmes fichiers).
Première action concrète : retirer l'entrée `PostToolUse` de `.claude/__settings.jsonc`, supprimer
`.claude/hooks/format-and-lint.ts` et son test — c'est le mensonge le plus visible du repo et il tombe en un commit.

---

## 6. Outillage par option

Tous les outils cités sont vérifiés installables sur cette machine : shellcheck 0.11.0 et shfmt 3.13.1 sont
**déjà installés** (pacman + shims mise) ; `biome`, `oxlint`, `oxfmt`, `actionlint` figurent au registre mise
(`mise registry`) ; `typescript` et `@biomejs/biome` s'installent via `bun add -d` (le repo a déjà bun via `mise.toml`).

| Option | Outil | Point d'accroche exact |
|---|---|---|
| 1 | aucun nouveau | lefthook `pre-commit` et hooks existants, chemins mis à jour |
| 2 | `typescript` + `@types/bun` (`bun add -d`) | lefthook `pre-commit` : job `typecheck`, `run: bun x tsc --noEmit` ; CI : step après `bun install --frozen-lockfile` |
| 2 | — | CI `.github/workflows/ci.yml:28` : `bun test && bun test ./.claude/hooks/*.test.ts` (remplace `bun test scripts`) |
| 3 | Biome (`bun add -d @biomejs/biome` + `biome.json` racine) | lefthook : job `lint-ts`, glob `*.{ts,js,mjs}`, `run: bun x biome check {staged_files}` ; CI : `bun x biome ci .` ; hook `PostToolUse` réécrit sur `Edit\|Write` |
| 3 | shellcheck (installé) | lefthook : job `lint-sh`, glob `*.sh` + les 10 exécutables bash, `run: shellcheck {staged_files}` ; CI : même commande sur `git ls-files` |
| 3 | shfmt (installé, optionnel) | lefthook : `shfmt -d {staged_files}` |
| 3 | actionlint (mise, optionnel) | CI : lint de `ci.yml` lui-même |

Alternative à Biome si un outil plus léger est préféré : `oxlint` + `oxfmt` (registre mise, mêmes points
d'accroche). En choisir **un** ; ne pas empiler les deux.

---

## 7. Non établi

- **Le volume d'erreurs du premier `tsc --noEmit`.** Le mesurer exige d'installer `typescript`
  (modification de `package.json`), hors périmètre de cet audit.
- **La date de disparition de `_hooks-lib/` du disque.** Jamais suivi par git (repo imbriqué, gitignoré) ;
  seul `5e77d1e` (2026-03-11) atteste son existence. Le hook qui le vise est donc un no-op depuis une date
  comprise entre le 2026-03-11 et aujourd'hui, indéterminable depuis l'historique.
- **L'intention de garder deux copies des hooks.** Les messages de `bacccbb` (« reusable library examples »)
  et `1fbd81e` (« adapted for this repo's structure ») documentent le quoi, pas la décision de conserver les deux.
- **L'usage réel de `conductor/`, `goalify/`, `design-studio/`.** Seuls les commits datent l'activité :
  design-studio touché le 2026-08-14, conductor le 2026-07-26, goalify un commit unique le 2026-06-24.
  Aucun ne montre de casse ; « peu commité » ne prouve pas « abandonné ».
- **Si `session-archive` est branché dans la config utilisateur globale** (`~/.claude/settings.json`, hors repo).
- **Le volume de corrections Biome/oxlint initiales** sur les 39 `.ts` (aucun outil installé pour le mesurer
  sans modifier le repo).
