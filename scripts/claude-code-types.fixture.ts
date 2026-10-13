import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { RUN_GUARD } from "./claude-code-types.ts";

// Stands in for `claude` as measured on 2.1.296: an interactive session that
// loads a mod with --plugin-dir writes the mod's types into its
// .claude-plugin/types/, then waits at its prompt, once its config marks the
// onboarding done and its folder trusted; before that, a dialog holds it,
// which the stub ends at once. The tool types follow the environment and the
// account, so the stub writes other tools for a login variable or a config
// holding more than that state. A run given --permission-mode is the agent: it
// records its prompt and writes the body where the prompt says; each control
// file under stub/ adds or changes one move.
const CLAUDE_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
version="$(cat "$stub/version")"
if [[ $1 == --version ]]; then
  echo "\${${RUN_GUARD}:-unset}" >>"$stub/version-guards"
  echo "$version (Claude Code)"
  exit 0
fi
if [[ " $* " == *" --plugin-dir "* ]]; then
  echo "$*" >>"$stub/types-runs"
  echo "$PWD" >>"$stub/types-cwds"
  if [[ -t 0 ]]; then echo terminal; else echo pipe; fi >>"$stub/types-stdins"
  echo "$$" >>"$stub/types-pids"
  if [[ -f $stub/types-silent ]]; then
    echo "stub: mods off" >&2
    echo "stub: wrote nothing"
    exit 1
  fi
  if [[ -f $stub/types-killed ]]; then
    echo "stub: about to be killed"
    kill -KILL $$
  fi
  if [[ -f $stub/types-held ]]; then exec sleep 600; fi
  if [[ -f $stub/types-deaf ]]; then trap '' TERM; fi
  config_state="$(cat "\${CLAUDE_CONFIG_DIR:-}/.claude.json" 2>/dev/null || true)"
  if [[ $config_state != *'"hasCompletedOnboarding":true'* || $config_state != *"\\"$PWD\\":{\\"hasTrustDialogAccepted\\":true}"* ]]; then
    echo "stub: a dialog holds the session"
    exit 1
  fi
  mod=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --plugin-dir) mod="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  tools="// tools $version"
  if [[ -n \${ANTHROPIC_API_KEY:-}\${CLAUDE_CODE_OAUTH_TOKEN:-} || "$(ls -A "$CLAUDE_CONFIG_DIR")" != .claude.json ]]; then
    tools="// tools of this account and environment"
  fi
  types="$mod/.claude-plugin/types"
  place() { mkdir -p "$types/$1"; echo "$2" >"$types/$1/index.d.ts.tmp"; mv "$types/$1/index.d.ts.tmp" "$types/$1/index.d.ts"; }
  place claude-code "// Written by Claude Code $version."
  place claude-code-tools "$tools"
  place claude-code-mcp "// mcp"
  exec sleep 600
fi
printf '%s' "\${!#}" >"$stub/agent-prompt"
echo "$PWD \${${RUN_GUARD}:-unset} \${*:1:$#-1}" >>"$stub/agent-runs"
echo "$$" >>"$stub/agent-pids"
if [[ -f $stub/agent-exit ]]; then exit "$(cat "$stub/agent-exit")"; fi
if [[ -f $stub/agent-sleep ]]; then sleep "$(cat "$stub/agent-sleep")"; fi
if [[ -f $stub/agent-commits-types ]]; then
  git -c core.hooksPath=/dev/null commit -qm "chore(vellum): types from Claude Code $version"
fi
if [[ -f $stub/agent-e2e ]]; then
  mkdir -p vellum/src
  echo "export {};" >vellum/src/page.ts
  git add -A
  git commit -qm "feat(vellum): a page"
fi
if [[ -f $stub/agent-dirty ]]; then echo stray >stray.txt; fi
if [[ -f $stub/agent-switches ]]; then git switch -qc elsewhere; fi
body="$(grep -oP 'pull request body to \`\\K[^\`]+' "$stub/agent-prompt")"
echo "the body" >"$body"
`;

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
stub="$(dirname "$0")/../stub"
echo "$*" >>"$stub/gh-calls"
case "$1 $2" in
  "pr list") if [[ -f $stub/gh-open ]]; then cat "$stub/gh-open"; else echo "[]"; fi ;;
  "pr create") echo "https://github.com/o/r/pull/7" ;;
esac
`;

const NOTIFY_STUB = `#!/usr/bin/env bash
echo "$*" >>"$(dirname "$0")/../stub/notify-calls"
`;

// The script runs under the real bun (process.execPath); only the installs it
// starts by name reach this stub.
const BUN_STUB = `#!/usr/bin/env bash
echo "$PWD $*" >>"$(dirname "$0")/../stub/bun-calls"
`;

export function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * The environment a test runs the pipeline or its hook in: claude, gh,
 * notify-send and bun stubbed under `<root>/bin`, ahead of the system's on
 * PATH, a gitconfig of its own, and none of the session's git or run
 * variables. Every tool the pipeline starts by name has its stub here, so no
 * test reaches the desktop or GitHub; each stub records under `<root>/stub`.
 */
export function stubbedEnv(root: string): NodeJS.ProcessEnv {
  write(
    join(root, "gitconfig"),
    "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = dev\n",
  );

  for (const [name, content] of [
    ["claude", CLAUDE_STUB],
    ["gh", GH_STUB],
    ["notify-send", NOTIFY_STUB],
    ["bun", BUN_STUB],
  ] as const) {
    write(join(root, "bin", name), content);
    chmodSync(join(root, "bin", name), 0o755);
  }

  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("GIT_") && name !== RUN_GUARD,
      ),
    ),
    HOME: root,
    PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
