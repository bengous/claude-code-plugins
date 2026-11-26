import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomicSync } from "../lib/platform/fs.ts";
import { run } from "../lib/platform/process.ts";

const INSTALL = join(import.meta.dir, "install.ts");

/** What git exports to a hook it runs, which would send `git init` to the caller's repository. */
const NO_GIT_ENV = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

let target = "";

async function exec(argv: readonly [string, ...string[]], cwd: string): Promise<number> {
  const result = await run(argv, { cwd, env: NO_GIT_ENV });

  if (result.kind !== "exited") throw new Error(`${argv.join(" ")}: ${JSON.stringify(result)}`);

  return result.code;
}

/** A fresh repository with the factory installed, nothing of this repository beside it. */
beforeAll(async () => {
  target = mkdtempSync(join(tmpdir(), "factory-installed-"));
  expect(await exec(["git", "init", "-q"], target)).toBe(0);

  const flags = ["--owner", "octo", "--routine", "trig_1", "--branch", "main", "--ci", "CI"];

  expect(
    await exec([process.execPath, INSTALL, "repo", ...flags, "--target", target], target),
  ).toBe(0);
});

afterAll(() => {
  rmSync(target, { recursive: true, force: true });
});

/** The fixtures a skill ships under `fixtures/<kind>/`, as paths in the installed repository. */
function fixtures(skill: string, kind: "pass" | "refuse", extension: string): string[] {
  const dir = join(".claude", "skills", skill, "fixtures", kind);

  return readdirSync(join(target, dir))
    .filter((name) => name.endsWith(extension))
    .map((name) => join(dir, name));
}

describe("the issue skill's check, installed in a fresh repository", () => {
  const check = ".claude/skills/issue/scripts/check-issue.ts";

  test("passes every draft its pass fixtures hold", async () => {
    const drafts = fixtures("issue", "pass", ".md");

    expect(drafts.length).toBeGreaterThan(0);

    for (const draft of drafts) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time names the draft that failed.
      expect([draft, await exec([process.execPath, check, draft], target)]).toEqual([draft, 0]);
    }
  });

  test("refuses every draft its refuse fixtures hold", async () => {
    const drafts = fixtures("issue", "refuse", ".md");

    expect(drafts.length).toBeGreaterThan(0);

    for (const draft of drafts) {
      // oxlint-disable-next-line no-await-in-loop -- one check at a time names the draft that passed.
      expect([draft, await exec([process.execPath, check, draft], target)]).toEqual([draft, 1]);
    }
  });

  test("reads the caps the repository tuned", async () => {
    const draft = fixtures("issue", "pass", ".md")[0] ?? "";

    writeAtomicSync(
      join(target, ".github/github-flow.json"),
      JSON.stringify({ issue: { unknown: 1 } }),
      { mkdir: true },
    );

    try {
      expect(await exec([process.execPath, check, draft], target)).toBe(2);
    } finally {
      rmSync(join(target, ".github/github-flow.json"));
    }
  });
});
