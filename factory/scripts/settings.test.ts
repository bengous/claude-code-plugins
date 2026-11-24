import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mergeHooks } from "./settings.ts";
import { SETTINGS_HOOKS, TEMPLATES_DIR } from "./templates.ts";

const FRAGMENT = readFileSync(join(TEMPLATES_DIR, SETTINGS_HOOKS), "utf8");

const START = 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/require-verify.sh" start';

const CLOUD_TOOLS = 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/cloud-tools.sh"';

const RECORD = 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/require-verify.sh" record';

const STOP = 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/require-verify.sh" stop';

interface Settings {
  readonly permissions?: { readonly allow: readonly string[] };
  readonly hooks: Readonly<
    Record<
      string,
      readonly {
        readonly matcher?: string;
        readonly hooks: readonly {
          readonly type: string;
          readonly command: string;
          readonly timeout?: number;
        }[];
      }[]
    >
  >;
}

function merged(current: string | null): Settings {
  const result = mergeHooks(current, FRAGMENT);

  if (result.kind !== "merged") throw new Error(`not merged: ${JSON.stringify(result)}`);

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- the assertions below fail on any other shape.
  return JSON.parse(result.text) as Settings;
}

describe("mergeHooks", () => {
  test("a repository without settings gets the factory's hooks", () => {
    const settings = merged(null);

    expect(settings.hooks["SessionStart"]).toEqual([
      { hooks: [{ type: "command", command: START }] },
      { hooks: [{ type: "command", command: CLOUD_TOOLS, timeout: 120 }] },
    ]);
    expect(settings.hooks["PostToolUse"]).toEqual([
      { matcher: "Skill", hooks: [{ type: "command", command: RECORD }] },
    ]);
    expect(settings.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe(STOP);
  });

  test("keeps what the file holds, its own hooks on the same events included", () => {
    const current = JSON.stringify({
      permissions: { allow: ["Bash(bun test:*)"] },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "bun run typecheck" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "bun install" }] }],
      },
    });

    const settings = merged(current);

    expect(settings.permissions).toEqual({ allow: ["Bash(bun test:*)"] });
    expect(settings.hooks["SessionStart"]?.[0]?.hooks[0]?.command).toBe("bun install");
    expect(settings.hooks["Stop"]?.map((group) => group.hooks[0]?.command)).toEqual([
      "bun run typecheck",
      STOP,
    ]);
    expect(settings.hooks["PostToolUse"]?.[0]?.matcher).toBe("Skill");
  });

  test("a second merge changes nothing", () => {
    const first = mergeHooks(null, FRAGMENT);

    if (first.kind !== "merged") throw new Error("not merged");

    expect(mergeHooks(first.text, FRAGMENT)).toEqual({ kind: "identical" });
  });

  test("adds only the hook that is missing", () => {
    const current = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: STOP }] }] },
    });

    const settings = merged(current);

    expect(settings.hooks["Stop"]).toHaveLength(1);
    expect(settings.hooks["PostToolUse"]).toHaveLength(1);
  });

  test.each([
    ["{ not json", ".claude/settings.json is not JSON"],
    ["[]", ".claude/settings.json is not a JSON object"],
    ['{"hooks": []}', ".claude/settings.json: hooks is not an object"],
    ['{"hooks": {"Stop": {}}}', ".claude/settings.json: hooks.Stop is not a list"],
  ])("refuses a file it cannot read, and rewrites nothing: %p", (current, why) => {
    const result = mergeHooks(current, FRAGMENT);

    expect(result.kind).toBe("refused");
    expect(JSON.stringify(result)).toContain(why);
  });
});
