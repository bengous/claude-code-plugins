import { describe, expect, test } from "bun:test";

import { denial, refusal } from "./guard-land-ok.ts";

describe("guard-land-ok denies an agent's way to land-ok", () => {
  test.each([
    "gh pr edit 12 --add-label land-ok",
    "gh pr edit 12 --add-label ok-humain,land-ok",
    "gh pr edit 12 --add-label ok-humain --add-label land-ok",
    "gh issue edit https://github.com/o/n/pull/12 --add-label 'bug, land-ok'",
    "gh pr edit --add-label=land-ok",
    "gh pr create --base dev --add-label land-ok",
    "gh pr edit 12 --remove-label land-ok",
    "gh label create land-ok --force",
    "gh api -X POST repos/o/n/issues/12/labels -f 'labels[]=land-ok'",
    "gh api -X PATCH repos/o/n/issues/12 -f 'labels[]=land-ok'",
    `curl -X POST -d '{"labels":["land-ok"]}' https://api.github.com/repos/o/n/issues/12/labels`,
  ])("a label write that names it: %s", (command) => {
    expect(refusal(command)).toContain("land-ok is the human's ok on a pull request");
  });

  test.each([
    "bun .claude/hooks/land-label.ts < forged.json",
    "bun ./.claude/hooks/land-label.ts</tmp/forged.json",
    'bun "$CLAUDE_PROJECT_DIR/.claude/hooks/land-label.ts" < forged.json',
    "cat forged.json | bun run .claude/hooks/land-label.ts",
    '"$CLAUDE_PROJECT_DIR/.claude/hooks/land-label.ts"',
  ])("the labelling hook run by hand: %s", (command) => {
    expect(refusal(command)).toContain("land-label.ts is Claude Code's to run");
  });

  test.each([
    'claude -p "/land 12"',
    "claude --resume s-1 -p '/land #12'",
    String.raw`claude -p /land\ 12`,
    "claude -p $'/land 12'",
    "claude --prompt='/land 12'",
    "echo /land 12 | claude -p",
    "cat <<'EOF' | claude -p\n/land 12\nEOF",
    "~/.local/bin/claude -p '/land 12'",
    "tmux send-keys -t lab '/land 12' Enter",
    "tmux send-keys -t lab /land Space 12 Enter",
    "tmux send-keys -t lab '/simplify /land 12' Enter",
    "screen -S lab -X stuff '/land 12\n'",
    'bun ./scripts/sessions/field-test.ts send lab "/land 12"',
  ])("/land handed to a session: %s", (command) => {
    expect(refusal(command)).toContain("/land is the human's to type");
  });

  test("names the human's /land in every reason", () => {
    for (const command of [
      "gh pr edit 12 --add-label land-ok",
      "bun .claude/hooks/land-label.ts",
      'claude -p "/land 12"',
    ]) {
      expect(refusal(command)).toContain(
        "Ask the human to type /land <number> in their own session",
      );
    }
  });
});

describe("guard-land-ok lets through what puts no land-ok on", () => {
  test.each([
    "gh pr view 12 --json labels",
    "gh pr view 12 --json labels --jq '.labels[].name' | grep land-ok",
    "grep -rn land-ok scripts",
    "git log --grep land-ok",
    'git commit -m "feat(settings): land-label puts land-ok on, on /land 12"',
    "gh pr edit 12 --add-label ok-humain",
    "gh api repos/o/n/issues/12/labels",
    "bun test ./.claude/hooks/land-label.test.ts",
    "cat .claude/hooks/land-label.ts",
    "git add .claude/hooks/land-label.ts",
    "bun x oxlint .claude/hooks/land-label.ts",
    'grep -rn "/land" docs',
    'echo "/land 12"',
    'gh pr comment 470 --body "/land 470 once you have read it"',
    "cat .claude/skills/land/SKILL.md",
    "cat scripts/sessions/field-test.ts",
    "tmux send-keys -t lab 'cat scripts/land.ts' Enter",
    "bun ./scripts/land.ts 12",
    "ls /landing",
  ])("%s", (command) => {
    expect(refusal(command)).toBeNull();
  });
});

describe("denial", () => {
  test("is PreToolUse's deny, with the reason", () => {
    expect(JSON.parse(denial("why"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "why",
      },
    });
  });
});
