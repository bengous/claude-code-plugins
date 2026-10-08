import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { RUN_GUARD } from "./claude-code-types.ts";

// Stands in for `claude` as measured on 2.1.287: a run that loads a mod with
// --plugin-dir writes the mod's types into its .claude-plugin/types/, then,
// given no prompt, stops on it. The tool types follow the environment and the
// account, so the stub writes other tools for a login variable or a config
// that is not empty. A run given --permission-mode is the agent: it records
// its prompt and writes the body where the prompt says; each control file
// under stub/ adds or changes one move.
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
  if [[ -f $stub/types-silent ]]; then
    echo "stub: mods off" >&2
    echo "stub: wrote nothing"
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
  if [[ -n \${ANTHROPIC_API_KEY:-}\${CLAUDE_CODE_OAUTH_TOKEN:-} || -z \${CLAUDE_CONFIG_DIR:-} || -n "$(ls -A "$CLAUDE_CONFIG_DIR")" ]]; then
    tools="// tools of this account and environment"
  fi
  types="$mod/.claude-plugin/types"
  mkdir -p "$types/claude-code" "$types/claude-code-tools" "$types/claude-code-mcp"
  echo "// Written by Claude Code $version." >"$types/claude-code/index.d.ts"
  echo "$tools" >"$types/claude-code-tools/index.d.ts"
  echo "// mcp" >"$types/claude-code-mcp/index.d.ts"
  echo "Error: Input must be provided either through stdin or as a prompt argument when using --print" >&2
  exit 1
fi
printf '%s' "\${!#}" >"$stub/agent-prompt"
echo "$PWD \${${RUN_GUARD}:-unset} \${*:1:$#-1}" >>"$stub/agent-runs"
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
