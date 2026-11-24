import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gitSync } from "../../tools/platform/git.ts";
import { COPY_DIR, problemsIn, SOURCE_DIR, WRITE_COMMAND, writeCopies } from "./sync-skills.ts";

let root = "";

const KEPT_GIT_ENV = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"));

/** A pre-push hook or a linked worktree exports `GIT_DIR`, which would point the gate's git at the pushing repository. */
beforeAll(() => {
  for (const [name] of KEPT_GIT_ENV) delete process.env[name];
});

afterAll(() => {
  for (const [name, value] of KEPT_GIT_ENV) process.env[name] = value;
});

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A repository whose `pr` skill holds a SKILL.md and a script, its copy not yet written. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-skills-"));
  expect(gitSync(["init", "-q"], { cwd: root, scrubGitEnv: true })).toMatchObject({ code: 0 });
  write(`${SOURCE_DIR}/pr/SKILL.md`, "# pr\n");
  write(`${SOURCE_DIR}/pr/scripts/check-pr.ts`, "export const check = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sync-skills", () => {
  test("refuses a copy that lacks a file of its source", async () => {
    expect(await problemsIn(root, ["pr"])).toEqual([
      `${COPY_DIR}/pr/SKILL.md: missing; edit ${SOURCE_DIR}/, never the copy, then run ${WRITE_COMMAND}`,
      `${COPY_DIR}/pr/scripts/check-pr.ts: missing; edit ${SOURCE_DIR}/, never the copy, then run ${WRITE_COMMAND}`,
    ]);
  });

  test("--write makes the copy pass, and a second write changes nothing", async () => {
    expect(await writeCopies(root, ["pr"])).toEqual([
      `${COPY_DIR}/pr/SKILL.md`,
      `${COPY_DIR}/pr/scripts/check-pr.ts`,
    ]);
    expect(readFileSync(join(root, COPY_DIR, "pr/scripts/check-pr.ts"), "utf8")).toBe(
      "export const check = 1;\n",
    );
    expect(await problemsIn(root, ["pr"])).toEqual([]);
    expect(await writeCopies(root, ["pr"])).toEqual([]);
  });

  test("refuses a copy edited by hand", async () => {
    await writeCopies(root, ["pr"]);
    write(`${COPY_DIR}/pr/SKILL.md`, "# pr, tuned\n");

    expect(await problemsIn(root, ["pr"])).toEqual([
      `${COPY_DIR}/pr/SKILL.md: differs from ${SOURCE_DIR}/pr/SKILL.md; edit ${SOURCE_DIR}/, never the copy, then run ${WRITE_COMMAND}`,
    ]);
  });

  test("refuses a file the copy holds beyond its source, which --write removes", async () => {
    await writeCopies(root, ["pr"]);
    write(`${COPY_DIR}/pr/stray.md`, "x\n");

    expect(await problemsIn(root, ["pr"])).toEqual([
      `${COPY_DIR}/pr/stray.md: ${SOURCE_DIR}/pr/ holds no such file; edit ${SOURCE_DIR}/, never the copy, then run ${WRITE_COMMAND}`,
    ]);
    expect(await writeCopies(root, ["pr"])).toEqual([`${COPY_DIR}/pr/stray.md (removed)`]);
    expect(existsSync(join(root, COPY_DIR, "pr/stray.md"))).toBe(false);
  });

  test("refuses a {{NAME}} token in the source, and passes other braces", async () => {
    write(`${SOURCE_DIR}/pr/SKILL.md`, '# pr\n\nA gate `id{{"blocks"}}`, a token {{BRANCH}}.\n');
    await writeCopies(root, ["pr"]);

    expect(await problemsIn(root, ["pr"])).toEqual([
      `${SOURCE_DIR}/pr/SKILL.md: holds a {{NAME}} token, which the factory's install reads as a parameter; write it another way`,
    ]);
  });

  test("leaves an ignored file out of both sides", async () => {
    write(".gitignore", "*.log\n");
    write(`${SOURCE_DIR}/pr/run.log`, "x\n");
    await writeCopies(root, ["pr"]);

    expect(existsSync(join(root, COPY_DIR, "pr/run.log"))).toBe(false);
    expect(await problemsIn(root, ["pr"])).toEqual([]);
  });

  test("refuses a listed skill whose source holds no file", async () => {
    expect(await problemsIn(root, ["issue"])).toEqual([
      `${SOURCE_DIR}/issue: the factory installs this skill, but it holds no file; fix SKILLS in scripts/gates/sync-skills.ts`,
    ]);
  });
});
