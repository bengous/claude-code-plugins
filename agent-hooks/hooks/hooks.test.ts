import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEADLINES_MS } from "../core/runtime/hook.ts";
import { isRecord, recordField, stringField } from "../core/util/json.ts";

const DEADLINES: ReadonlyMap<string, number> = new Map([
  ["session-start", DEADLINES_MS["session-start"]],
  ["pre-edit", DEADLINES_MS["pre-edit"]],
  ["pre-bash", DEADLINES_MS["pre-bash"]],
  ["stop", DEADLINES_MS.stop],
  ["user-prompt-expansion", DEADLINES_MS["user-prompt-expansion"]],
]);

/** The subcommands that run no handler, so the kit gives them no deadline. */
const UNDEADLINED = new Set(["user-prompt-submit", "session-end"]);

/** Claude Code's default timeout for a UserPromptSubmit command hook, in seconds. */
const PROMPT_DEFAULT_TIMEOUT_S = 30;

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
  test("wires every subcommand of the kit's hooks", () => {
    expect(new Set(commands.map(([, subcommand]) => subcommand))).toEqual(
      new Set([
        "session-start",
        "user-prompt-submit",
        "pre-edit",
        "pre-bash",
        "stop",
        "session-end",
        "user-prompt-expansion",
      ]),
    );
  });

  test.each(commands.filter(([, subcommand]) => !UNDEADLINED.has(subcommand)))(
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

  test("user-prompt-submit runs at UserPromptSubmit alone, under a timeout shorter than that event's default: the prompt waits for it", () => {
    const wired = commands.filter(([, subcommand]) => subcommand === "user-prompt-submit");

    expect(wired.map(([event]) => event)).toEqual(["UserPromptSubmit"]);
    expect(wired[0]?.[2]).toBeNumber();
    expect(Number(wired[0]?.[2])).toBeLessThan(PROMPT_DEFAULT_TIMEOUT_S);
  });
});
