import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Consumer } from "../tools/platform/consumers.ts";
import { gitSync, run } from "../tools/platform/node.ts";
import { problemsIn, WRITE_COMMAND, writeCopies } from "./sync-platform.ts";

const REPO = join(import.meta.dir, "..");

const PLUG: Consumer = { dir: "plug/lib/platform", files: ["pure.ts"] };

let root = "";

function write(path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const KEPT_GIT_ENV = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"));

/** A pre-push hook or a linked worktree exports `GIT_DIR`, which would point the gate's git at the pushing repository. */
beforeAll(() => {
  for (const [name] of KEPT_GIT_ENV) delete process.env[name];
});

afterAll(() => {
  for (const [name, value] of KEPT_GIT_ENV) process.env[name] = value;
});

/** A repository whose catalog lists `plug/` and `peer/`, beside `other/`, a directory no catalog names. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-platform-"));
  expect(gitSync(["init", "-q"], { cwd: root, scrubGitEnv: true })).toMatchObject({ code: 0 });
  write(".gitignore", "*.tmp\n.DS_Store\n");
  write("tools/platform/pure.ts", "export const pure = 1;\n");
  write("tools/platform/node.ts", "export const node = 1;\n");

  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ plugins: [{ source: "./plug" }, { source: "./peer" }] }),
  );

  write("plug/hooks/register.ts", "export const register = 1;\n");
  write("peer/x.ts", "export const x = 1;\n");
  write("other/x.ts", "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const problems = (consumers: readonly Consumer[] = [PLUG]): Promise<string[]> =>
  problemsIn(root, consumers);

describe("the check", () => {
  test("passes copies identical to their source", async () => {
    await writeCopies(root, [PLUG]);

    expect(await problems()).toEqual([]);
  });

  test("refuses a copy edited by hand, and says to edit the source", async () => {
    await writeCopies(root, [PLUG]);
    write("plug/lib/platform/pure.ts", "export const pure = 2;\n");

    expect(await problems()).toEqual([
      `plug/lib/platform/pure.ts differs from tools/platform/pure.ts: edit tools/platform/, never a copy, then run ${WRITE_COMMAND}`,
    ]);
  });

  test("refuses a listed file the copy lacks", async () => {
    expect(await problems()).toEqual([
      `plug/lib/platform/pure.ts is missing: run ${WRITE_COMMAND}`,
    ]);
  });

  test("refuses a file the copy holds beyond its list", async () => {
    await writeCopies(root, [PLUG]);
    write("plug/lib/platform/node.ts", "export const node = 1;\n");

    expect(await problems()).toEqual([
      `plug/lib/platform/node.ts is no file consumers.ts lists for plug/lib/platform: edit tools/platform/, never a copy, then run ${WRITE_COMMAND}, which removes it`,
    ]);
  });

  test("refuses a consumer whose directory does not exist", async () => {
    expect(await problems([{ dir: "ghost/lib/platform", files: ["pure.ts"] }])).toEqual([
      "ghost/lib/platform: tools/platform/consumers.ts lists it, but ghost/ does not exist; fix the entry",
    ]);
  });

  test("refuses a copy of node.ts without the pure.ts it imports", async () => {
    expect(await problems([{ dir: "plug/lib/platform", files: ["node.ts"] }])).toContain(
      "plug/lib/platform: tools/platform/consumers.ts names its files once each, pure.ts alone or pure.ts and node.ts, which imports ./pure.ts",
    );
  });

  test("leaves a file git ignores in a copy directory, and --write keeps it", async () => {
    write("plug/lib/platform/.DS_Store", "finder\n");
    write("plug/lib/platform/.pure.ts.4242.interrupted.tmp", "half\n");

    expect(await writeCopies(root, [PLUG])).toEqual(["plug/lib/platform/pure.ts"]);
    expect(await problems()).toEqual([]);
    expect(readFileSync(join(root, "plug/lib/platform/.DS_Store"), "utf8")).toBe("finder\n");
  });

  test("refuses a listed copy git ignores, which no commit carries", async () => {
    write(".gitignore", "plug/lib/platform/pure.ts\n");
    await writeCopies(root, [PLUG]);

    expect(await problems()).toEqual([
      "plug/lib/platform/pure.ts is ignored by git, so no commit carries it: unignore it",
    ]);
  });

  test("refuses a copy that is a link to its source, and --write puts a file in its place", async () => {
    mkdirSync(join(root, "plug/lib/platform"), { recursive: true });
    symlinkSync(join(root, "tools/platform/pure.ts"), join(root, "plug/lib/platform/pure.ts"));

    expect(await problems()).toEqual([
      `plug/lib/platform/pure.ts is a symbolic link, which a plugin installed alone loses: edit tools/platform/, never a copy, then run ${WRITE_COMMAND}`,
    ]);
    expect(await writeCopies(root, [PLUG])).toEqual(["plug/lib/platform/pure.ts"]);
    expect(lstatSync(join(root, "plug/lib/platform/pure.ts")).isSymbolicLink()).toBe(false);
    expect(await problems()).toEqual([]);
  });

  test("refuses a consumer outside <owner>/lib/platform or <owner>/src/platform", async () => {
    const [problem] = await problems([{ dir: "plug/hooks/platform", files: ["pure.ts"] }]);

    expect(problem).toStartWith("plug/hooks/platform: a copy lives at <owner>/lib/platform");
  });

  test("refuses a copy directory consumers.ts does not list", async () => {
    write("other/src/platform/pure.ts", "export const pure = 1;\n");

    expect(await problems([])).toEqual([
      `other/src/platform/ holds files tools/platform/consumers.ts lists no copy for: add its entry and run ${WRITE_COMMAND}, or move them out`,
    ]);
  });

  test("refuses a plugin's import of tools/platform/, and a consumer's", async () => {
    await writeCopies(root, [PLUG, { dir: "other/lib/platform", files: ["pure.ts"] }]);
    write("plug/hooks/a.ts", 'import { pure } from "../../tools/platform/pure.ts";\npure;\n');
    write("other/b.ts", 'export { pure } from "../tools/platform/pure.ts";\n');

    const found = await problems([PLUG, { dir: "other/lib/platform", files: ["pure.ts"] }]);

    expect(found.map((problem) => problem.slice(0, problem.indexOf(":")))).toEqual([
      "other/b.ts imports ../tools/platform/pure.ts",
      "plug/hooks/a.ts imports ../../tools/platform/pure.ts",
    ]);
    expect(found[1]).toContain("edit tools/platform/, never a copy");
  });

  test.each([
    ["another plugin", "../../peer/x.ts"],
    ["scripts/", "../../scripts/lib/run.ts"],
    [".claude/", "../../.claude/hooks/checkout.ts"],
  ])("refuses a plugin's import of %s, outside its directory", async (_, specifier) => {
    await writeCopies(root, [PLUG]);
    write("plug/hooks/a.ts", `import { x } from "${specifier}";\nx;\n`);

    expect(await problems()).toEqual([
      `plug/hooks/a.ts imports ${specifier}, outside plug/: a plugin stands alone once installed, so no import leaves its directory`,
    ]);
  });

  test("leaves a type-only import, a copy's import and a directory no catalog names", async () => {
    await writeCopies(root, [PLUG]);
    write("plug/hooks/a.ts", 'import type { pure } from "../../tools/platform/pure.ts";\n');
    write("plug/hooks/b.ts", 'import { pure } from "../lib/platform/pure.ts";\npure;\n');
    write("other/c.ts", 'import { pure } from "../tools/platform/pure.ts";\npure;\n');

    expect(await problems()).toEqual([]);
  });
});

describe("--write", () => {
  test("repairs a differing copy, writes a missing one and removes a stray file", async () => {
    const both: Consumer = { dir: "plug/lib/platform", files: ["pure.ts", "node.ts"] };
    write("plug/lib/platform/pure.ts", "edited\n");
    write("plug/lib/platform/stray.ts", "stray\n");

    expect(await writeCopies(root, [both])).toEqual([
      "plug/lib/platform/pure.ts",
      "plug/lib/platform/node.ts",
      "plug/lib/platform/stray.ts (removed)",
    ]);
    expect(await problems([both])).toEqual([]);
    expect(readFileSync(join(root, "plug/lib/platform/pure.ts"), "utf8")).toBe(
      "export const pure = 1;\n",
    );
  });

  test("the command checks, refuses, then repairs with --write", async () => {
    for (const file of ["pure.ts", "node.ts"]) {
      copyFileSync(join(REPO, "tools/platform", file), join(root, "tools/platform", file));
    }

    mkdirSync(join(root, "scripts"));
    copyFileSync(join(REPO, "scripts/sync-platform.ts"), join(root, "scripts/sync-platform.ts"));
    write(
      "tools/platform/consumers.ts",
      'export const CONSUMERS = [{ dir: "plug/lib/platform", files: ["pure.ts", "node.ts"] }];\n',
    );

    const script = join(root, "scripts/sync-platform.ts");
    const check = await run([process.execPath, script], { cwd: root });

    expect(check).toMatchObject({ kind: "exited", code: 1 });
    expect(check.kind === "exited" ? check.stderr : "").toContain(
      "plug/lib/platform/pure.ts is missing",
    );
    expect(await run([process.execPath, script, "--write"], { cwd: root })).toMatchObject({
      kind: "exited",
      code: 0,
    });
    expect(await run([process.execPath, script], { cwd: root })).toMatchObject({
      kind: "exited",
      code: 0,
    });
    expect(readFileSync(join(root, "plug/lib/platform/node.ts"))).toEqual(
      readFileSync(join(REPO, "tools/platform/node.ts")),
    );
  });
});
