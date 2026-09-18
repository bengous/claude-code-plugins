import { describe, expect, test, tier } from "claude-code/testing";

import { approved, CWD, FINAL, WORKDIR } from "./fixtures/index.ts";
import { lockVerdict, type Verdict } from "./lock.ts";
import { editedPath, parsePending, projectDir } from "./parse.ts";
import { submitResult } from "./relay.ts";

tier("user");

const DENIED = {
  kind: "deny",
  reason: `vellum is planning: files outside ${WORKDIR} change after the plan is approved`,
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- `input` is the call's arguments as `tool.check` hands them over, which is what `editedPath` reads.
function verdict(tool: string, input: unknown, cwd: string = CWD): Verdict | { kind: "check" } {
  const path = editedPath(tool, input);

  return path === null ? { kind: "check" } : lockVerdict(path, cwd, CWD, WORKDIR);
}

describe("lockVerdict", () => {
  test("a file under the working directory is allowed outright", () => {
    expect(verdict("Edit", { file_path: `${CWD}/${WORKDIR}mockup.html` })).toEqual({
      kind: "allow",
    });
  });

  test("a file under the project and outside the working directory is denied", () => {
    expect(verdict("Write", { file_path: `${CWD}/src/cli.ts` })).toEqual(DENIED);
  });

  test("a file outside the project is the session's to decide", () => {
    const scratchpad = "/tmp/claude-1000/project/session/scratchpad/issue.md";
    expect(verdict("Write", { file_path: scratchpad })).toEqual({ kind: "check" });
  });

  test("a project at the root of the file system still holds the lock", () => {
    expect(lockVerdict("/etc/hosts", "/", CWD, WORKDIR)).toEqual({ kind: "check" });
    expect(lockVerdict("/etc/hosts", "/", projectDir("/"), WORKDIR)).toMatchObject({
      kind: "deny",
    });
  });

  test("a relative path is resolved against the session's directory", () => {
    expect(verdict("Edit", { file_path: `${WORKDIR}notes.md` })).toEqual({ kind: "allow" });
    expect(verdict("Edit", { file_path: `${WORKDIR}../escape.md` })).toEqual(DENIED);
  });

  test("the working directory hangs off the project root, wherever the session cd-ed", () => {
    const inside = `${CWD}/${WORKDIR}`;
    expect(verdict("Edit", { file_path: `${inside}plan.md` }, inside)).toEqual({ kind: "allow" });
    expect(verdict("Edit", { file_path: "plan.md" }, inside)).toEqual({ kind: "allow" });
    expect(verdict("Edit", { file_path: "../../../src/cli.ts" }, inside)).toEqual(DENIED);
  });

  test("NotebookEdit is read on notebook_path", () => {
    expect(verdict("NotebookEdit", { notebook_path: "src/n.ipynb" })).toEqual(DENIED);
  });

  test("a tool that writes no file is the session's to decide", () => {
    for (const tool of ["Bash", "Read", "mcp__other__write"]) {
      expect(verdict(tool, { command: "rm -rf /" }), tool).toEqual({ kind: "check" });
    }
  });
});

describe("submitResult", () => {
  test("a version tells the model to end its turn, recorded or kept: it acts the same on both", () => {
    expect(submitResult({ version: 1, kept: false })).toEqual({
      result: "Plan v1 under review. End your turn.",
    });
    expect(submitResult({ version: 2, kept: true })).toEqual({
      result: "Plan v2 under review. End your turn.",
    });
  });

  test("an error is the deny the model reads", () => {
    expect(submitResult({ error: "write plan.md in x/ first" })).toEqual({
      deny: "write plan.md in x/ first",
    });
  });
});

describe("parsePending", () => {
  test("an approval's notes are a path or null", () => {
    const notes = `${FINAL}.review/v3.notes.md`;

    expect(parsePending(JSON.stringify(approved(3, notes)))).toEqual(approved(3, notes));
    expect(parsePending(JSON.stringify(approved(3)))).toEqual(approved(3));
  });

  test("an approval whose notes are missing or no string is nothing to relay", () => {
    const { notes: _, ...bare } = approved(3);

    expect(parsePending(JSON.stringify(bare))).toEqual({ kind: "none" });
    expect(parsePending(JSON.stringify({ ...bare, notes: 3 }))).toEqual({ kind: "none" });
  });
});
