import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEADLINES_MS } from "./hook.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import { PRE_BASH_DEADLINE_MS } from "./pre-bash.ts";

const DEADLINES: ReadonlyMap<string, number> = new Map([
  ["session-start", DEADLINES_MS["session-start"]],
  ["pre-edit", DEADLINES_MS["pre-edit"]],
  ["pre-bash", PRE_BASH_DEADLINE_MS],
  ["stop", DEADLINES_MS.stop],
]);

const manifest: unknown = JSON.parse(
  readFileSync(path.join(import.meta.dir, "hooks", "hooks.json"), "utf8"),
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
  test("wires every subcommand of the kit's hooks", () => {
    expect(new Set(commands.map(([, subcommand]) => subcommand))).toEqual(
      new Set(["session-start", "pre-edit", "pre-bash", "stop", "session-end"]),
    );
  });

  test.each(commands.filter(([, subcommand]) => subcommand !== "session-end"))(
    "%s %s: its timeout outlasts the kit's deadline, so the kit answers before the harness cuts it",
    (_event, subcommand, timeout) => {
      expect(timeout).toBeNumber();
      expect(Number(timeout) * 1000).toBeGreaterThan(
        DEADLINES.get(subcommand) ?? Number.POSITIVE_INFINITY,
      );
    },
  );

  test("session-end declares no timeout, the kit giving it no deadline", () => {
    expect(
      commands
        .filter(([, subcommand]) => subcommand === "session-end")
        .map(([, , timeout]) => timeout),
    ).toEqual([undefined]);
  });
});
