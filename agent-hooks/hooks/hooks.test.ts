import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEADLINES_MS } from "../core/runtime/hook.ts";
import { isRecord, recordField, stringField } from "../core/util/json.ts";

const DEADLINES: ReadonlyMap<string, number> = new Map([
  ["session-start", DEADLINES_MS["session-start"]],
  ["pre-edit", DEADLINES_MS["pre-edit"]],
  ["stop", DEADLINES_MS.stop],
]);

const manifest: unknown = JSON.parse(
  readFileSync(path.join(import.meta.dir, "hooks.json"), "utf8"),
);

const commands = Object.entries(
  (isRecord(manifest) ? recordField(manifest, "hooks") : undefined) ?? {},
).flatMap(([event, groups]) =>
  (Array.isArray(groups) ? groups : [])
    .flatMap((group) => (isRecord(group) && Array.isArray(group["hooks"]) ? group["hooks"] : []))
    .flatMap((hook) => {
      const command = isRecord(hook) ? stringField(hook, "command") : undefined;
      const subcommand = /agent-hooks\.ts"\s+(\S+)$/u.exec(command ?? "")?.[1];

      return subcommand === undefined || !isRecord(hook)
        ? []
        : [[event, subcommand, hook["timeout"]] as const];
    }),
);

describe("hooks/hooks.json", () => {
  test("wires every subcommand of the kit's Claude Code hooks", () => {
    expect(new Set(commands.map(([event, subcommand]) => `${event} ${subcommand}`))).toEqual(
      new Set([
        "SessionStart session-start",
        "PreToolUse pre-edit",
        "Stop stop",
        "SubagentStop stop",
      ]),
    );
  });

  test.each(commands)(
    "%s %s: its timeout outlasts the kit's deadline, so the kit answers before the harness cuts it",
    (_event, subcommand, timeout) => {
      expect(timeout).toBeNumber();
      expect(Number(timeout) * 1000).toBeGreaterThan(
        DEADLINES.get(subcommand) ?? Number.POSITIVE_INFINITY,
      );
    },
  );
});
