---
name: codex-orchestrate
description: Claude Code only. Use when the user explicitly invokes /agents-bridge:codex-orchestrate (or /codex-orchestrate) in Claude Code or asks Claude to orchestrate a large multi-slice plan by delegating implementation to the Codex CLI through agents-bridge. In native Codex, use $slice-runner instead.
---

# Orchestration de plans par slices via Codex

Claude Code only. Dans Codex natif, utiliser `$slice-runner`.

## Principe

Claude est **architecte, QA et committeur** ; Codex (gpt-5.6) est **l'exécutant**. Claude découpe le plan en slices séquentielles, impose les interfaces, lance un run Codex par slice, vérifie les gates lui-même, commite. Codex ne committe jamais et ne designe jamais : si Claude laisse Codex inventer une API, N slices produiront N styles.

## Routage modèle par slice

Choisir le tier au moment de rédiger le prompt de la slice (table complète : skill `codex` d'agents-bridge) :

| Slice | Modèle | Pourquoi |
|---|---|---|
| Code standard (features, câblage, refactor spécifié) | `gpt-5.6-terra` | Égale Sol sur Terminal-Bench à effort max, moitié prix. **Défaut.** |
| Tests, fixes mécaniques pour passer un gate | `gpt-5.6-luna` | Rapide, 40 % du coût de Terra, suffisant sur travail borné |
| Code demandant jugement/rigueur, points délicats denses | `gpt-5.6-sol` | Ceiling supérieur ; seul tier avec `max`/`ultra` |

Effort par défaut : `xhigh`. Les décisions hard (archi, choix d'API) restent le travail de Claude — si une slice en contient une, c'est un défaut de découpage, pas une raison de monter de tier.

Ces modèles délèguent eux-mêmes très bien : sur une slice lourde confiée à Sol, autoriser explicitement dans le prompt la délégation des sous-parties mécaniques à un modèle moins cher (et `ultra` décompose nativement en sous-agents internes) plutôt que sur-découper côté orchestrateur.

**Règle de contexte (non négociable)** : ne jamais lire l'output complet d'un run Codex ni son diff complet. Lecture = résumé final (`tail` court) + `git diff --stat` + gates. Inspection ciblée (grep, Read partiel) uniquement si un gate échoue ou si la slice comporte un point à risque identifié d'avance dans le prompt.

## Pré-vol

1. Plan validé par l'utilisateur, découpé en slices : petites, séquentielles, chacune avec un gate de sortie explicite (ex. `validate` seul pour le câblage interne ; + e2e/visual pour ce qui touche le DOM).
2. **Slice 0 = baseline** : tous les gates verts avant la première slice. Sinon, stop et rapport.
   Au passage, **figer la version Codex** : lire `codex --version` via le bridge (ex. `codex-cli 0.144.1`) et préfixer chaque invocation de slice par `AGENTS_BRIDGE_CODEX_VERSION=0.144.1`. Sans ce pin, le bridge peut rafraîchir sa résolution npm (TTL 24 h) entre deux slices — version qui bouge en cours de run.
3. Branche : suivre la consigne utilisateur ; par défaut une branche dédiée si un push sur main déclenche quelque chose. **Jamais de push** — l'utilisateur pousse.
4. Première slice = la plus petite et la plus autonome (smoke test du pipeline : env, conventions, sandbox).
5. `TaskCreate` une tâche par slice ; `TaskUpdate` au fil de l'eau.
6. Insérer une slice prérequise dès qu'un blocage transversal est découvert (ex. outillage de test manquant pour le nouveau pattern) — ne pas la fusionner dans la slice en cours.

## Boucle par slice

1. Rédiger le prompt (template ci-dessous) — interface imposée, sémantique à préserver point par point.
2. Lancer Codex en arrière-plan (mécanique ci-dessous).
3. À la notification : `tail` du résumé + `git diff --stat`. Inspection ciblée seulement sur les points à risque annoncés.
4. Lancer les gates **soi-même** (jamais sur la foi du « vert » annoncé par Codex).
5. Commit (message impératif, conventions du repo), tâche complétée, slice suivante.

## Template de prompt Codex

Toujours inclure, dans cet ordre :
- **Contexte** : stack + fichiers exemplaires à imiter (« suis le style de X »). Ne pas demander de lire CLAUDE.md/AGENTS.md : Codex charge AGENTS.md nativement (et CLAUDE.md n'est souvent qu'un import `@AGENTS.md`).
- **Objectif** : une phrase, avec « zéro changement de comportement » si refactor.
- **Interface imposée** : signatures exactes (types, noms, valeurs initiales), pas une intention.
- **Points délicats** : chaque subtilité sémantique nommée explicitement, avec le comportement attendu et l'implémentation suggérée.
- **Tests** : fichiers, cas, conventions de nommage ; « ne supprime aucun test existant ».
- **Interdits** : commit git, nouvelles dépendances, fichiers hors périmètre, + interdits du repo.
- **Documentation** : wiki/commentaires selon les conventions du repo, « reste minimal ».
- **Definition of done** : la commande de gate exacte, « corrige jusqu'au vert », « ne lance pas [suites lentes] (je m'en charge) », « résumé final court : fichiers + choix non triviaux ».

## Mécanique d'invocation

Le prompt s'écrit dans un fichier avec l'outil Write (jamais inline dans le
shell), puis se passe sur stdin via `-`. Modèle, effort et sandbox se passent
en **flags natifs** — le wrapper est un pur pass-through, il ne lit aucune
variable d'environnement Codex (`CODEX_MODEL`/`CODEX_REASONING`/`CODEX_SANDBOX`
seraient silencieusement ignorées et le run tournerait avec les défauts de
`~/.codex/config.toml`). Seule variable lue, côté bridge :
`AGENTS_BRIDGE_CODEX_VERSION`, qui fige la version du CLI (pin du pré-vol).

```bash
# 1. Write /tmp/slice-N-prompt.md  (outil Write — contenu = prompt de la slice)
# 2. Run, en arrière-plan :
AGENTS_BRIDGE_CODEX_VERSION=0.144.1 \
"${CLAUDE_PLUGIN_ROOT}/scripts/codex" exec \
  -m gpt-5.6-terra \
  -c model_reasoning_effort=xhigh \
  -s workspace-write \
  --json -o /tmp/slice-N.last \
  - < /tmp/slice-N-prompt.md > /tmp/slice-N.jsonl
```

- La forme `- < fichier` élimine tout échappement shell (`$`, backticks,
  quotes passent intacts) et stdin se ferme à EOF tout seul.
- `run_in_background: true`, timeout ≥ 900 s. Vérifier ~20 s après le lancement que l'output progresse (détecte les blocages immédiats).
- `-o` reçoit le résumé final de Codex ; le thread id se lit dans le JSONL
  (jamais `resume --last`, il race entre runs) :
  ```bash
  tid="$(jq -r 'select(.type=="thread.started") | .thread_id // empty' /tmp/slice-N.jsonl | head -n1)"
  ```
  Corrections → `exec resume "$tid" - < /tmp/slice-N-fix.md` (moins cher qu'un
  contexte neuf ; `resume` n'a pas de `-s`, il hérite du sandbox d'origine).

## Protocole d'échec

- Gate rouge → diagnostiquer d'abord : **échec de code** (reprendre la session Codex avec le rapport d'erreur exact) ou **échec d'environnement** (fichiers hors périmètre, config, outillage — le corriger soi-même, c'est le travail de l'orchestrateur, pas de l'exécutant).
- Deux échecs sur la même slice → stop, rapport à l'utilisateur. Ne pas insister.
- Déviation de Codex par rapport à la spec → juger sur pièces : si le contrat est préservé et le design défendable, accepter et le noter ; sinon resume avec correction.

## Pièges connus (vécus)

| Symptôme | Cause | Fix |
|---|---|---|
| Run figé, output = « Reading additional input from stdin... » | stdin pipe resté ouvert (prompt passé en argument) | forme `- < fichier` ; en dernier recours `< /dev/null`, kill + relance |
| Codex reçoit `()` au lieu de `($bindable)` | expansion shell des `$` (prompt inline) | prompt via fichier + stdin, jamais inline |
| Run tourne au mauvais modèle/effort/sandbox | env vars `CODEX_*` ignorées par le wrapper | flags natifs `-m` / `-c model_reasoning_effort=` / `-s` |
| `npm E404` sur le tarball, exit 127 en pleine orchestration | dist-tag `latest` cassé upstream, re-résolu en réseau | échec d'environnement, pas de code : le bridge retombe seul sur la dernière version installée ; le pin `AGENTS_BRIDGE_CODEX_VERSION` du pré-vol évite toute re-résolution en cours de run |
| Gate rouge sur des fichiers jamais touchés | pollution externe (skills installés, artefacts) | fix d'hygiène soi-même (ignore files), pas par Codex |
| Codex annonce vert, gate local rouge | environnements différents | toujours re-lancer les gates soi-même |
| Slice N dépend d'un outillage absent | prérequis transversal découvert tard | slice insérée, jamais fusionnée |
