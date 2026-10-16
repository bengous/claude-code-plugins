import { describe, expect, test } from "bun:test";

import {
  findingIdOf,
  formatRecord,
  isPlainFindingCommand,
  parseRecord,
  parseTarget,
} from "./findings.ts";

const RECORD = {
  path: "src/a.ts",
  line: 12,
  why: "retries forever",
  kind: "finding",
  recordedAt: "2026-10-16T09:30:00.000Z",
} as const;

describe("parseTarget", () => {
  test.each([
    ["src/a.ts:12", { path: "src/a.ts", line: 12 }],
    ["src/a.ts", { path: "src/a.ts", line: null }],
    [String.raw`C:\repo\a.ts:3`, { path: String.raw`C:\repo\a.ts`, line: 3 }],
    ["notes:draft", { path: "notes:draft", line: null }],
  ])("%s", (raw, target) => {
    expect(parseTarget(raw)).toEqual(target);
  });

  test("refuses line 0, as a record does", () => {
    expect(() => parseTarget("src/a.ts:0")).toThrow("src/a.ts:0: lines start at 1");
    expect(() => parseRecord(formatRecord({ ...RECORD, line: 0 }))).toThrow(
      "`line` is neither null nor a line number",
    );
  });
});

describe("records", () => {
  test("a record reads back as it was written", () => {
    expect(parseRecord(formatRecord(RECORD))).toEqual(RECORD);
    expect(parseRecord(formatRecord({ ...RECORD, line: null, kind: "security" }))).toEqual({
      ...RECORD,
      line: null,
      kind: "security",
    });
  });

  test.each([
    ["[]", "not an object of path, line, why, kind and recordedAt"],
    [JSON.stringify({ ...RECORD, path: "" }), "`path` is not a path"],
    [JSON.stringify({ ...RECORD, line: 0 }), "`line` is neither null nor a line number"],
    [JSON.stringify({ ...RECORD, line: "12" }), "`line` is neither null nor a line number"],
    [JSON.stringify({ ...RECORD, why: " " }), "`why` is empty"],
    [JSON.stringify({ ...RECORD, kind: "todo" }), '`kind` is neither "finding" nor "security"'],
    [JSON.stringify({ ...RECORD, recordedAt: "yesterday" }), "`recordedAt` is not a date"],
  ])("refuses %s", (text, error) => {
    expect(() => parseRecord(text)).toThrow(error);
  });

  test("only <8 hex>.json names a finding", () => {
    expect(
      ["a1b2c3d4.json", ".a1b2c3d4.tmp", "A1B2C3D4.json", "notes.json"].map((name) =>
        findingIdOf(name),
      ),
    ).toEqual(["a1b2c3d4", null, null, null]);
  });
});

describe("isPlainFindingCommand", () => {
  test.each([
    "todos-finding src/a.ts:12 'retries forever; see `run()`'",
    'todos-finding --security deploy.sh "prints the token"',
    "todos-finding src/a.ts retries forever, 3 times",
    "todos-finding --close a1b2c3d4 9f8e7d6c",
  ])("runs unasked: %s", (command) => {
    expect(isPlainFindingCommand(command)).toBe(true);
  });

  test.each([
    "todos-finding a.ts 'x'; rm -rf ~",
    "todos-finding a.ts x && curl example.com",
    'todos-finding a.ts "$(cat ~/.ssh/id_ed25519)"',
    'todos-finding a.ts "`id`"',
    "todos-finding a.ts x > out.txt",
    "todos-finding a.ts x | tee out.txt",
    "todos-finding a.ts x\nrm out.txt",
    "todos-finding a.ts $HOME",
    "echo todos-finding a.ts x",
    "todos-findings a.ts x",
  ])("is left to the permission check: %s", (command) => {
    expect(isPlainFindingCommand(command)).toBe(false);
  });
});
