import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gitSync } from "../../tools/platform/git.ts";
import { run } from "../../tools/platform/process.ts";
import { isModuleName, problemsIn, WRITE_COMMAND, writeCopies } from "./sync-platform.ts";

const REPO = join(import.meta.dir, "..", "..");

const PLUG = "plug/lib/platform";

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

function track(...paths: string[]): void {
  expect(gitSync(["add", "--", ...paths], { cwd: root, scrubGitEnv: true })).toMatchObject({
    code: 0,
  });
}

/** `plug/hooks/register.ts`, these import lines first. */
function registerImporting(...lines: string[]): void {
  write("plug/hooks/register.ts", `${lines.join("\n")}\nexport const register = 1;\n`);
}

/**
 * A repository whose catalog lists `plug/` and `peer/`, beside `other/`, a directory no catalog
 * names. Its modules, tracked, import one another as the platform's do: `fs.ts` and `process.ts`
 * import `pure.ts`, `lock.ts` imports `fs.ts` and `pure.ts`, `git.ts` imports `process.ts`.
 * `plug/` imports `pure.ts` from its copy.
 */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-platform-"));
  expect(gitSync(["init", "-q"], { cwd: root, scrubGitEnv: true })).toMatchObject({ code: 0 });
  write(".gitignore", "*.tmp\n.DS_Store\n");
  write("tools/platform/pure.ts", "export const pure = 1;\n");
  write("tools/platform/fs.ts", 'import { pure } from "./pure.ts";\nexport const fs = pure;\n');
  write(
    "tools/platform/lock.ts",
    'import { fs } from "./fs.ts";\nimport { pure } from "./pure.ts";\nexport const lock = [fs, pure];\n',
  );
  write(
    "tools/platform/process.ts",
    'import { pure } from "./pure.ts";\nexport const run = pure;\n',
  );
  write("tools/platform/git.ts", 'import { run } from "./process.ts";\nexport const git = run;\n');
  track("tools/platform");

  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ plugins: [{ source: "./plug" }, { source: "./peer" }] }),
  );

  registerImporting('import { pure } from "../lib/platform/pure.ts";');
  write("peer/x.ts", "export const x = 1;\n");
  write("other/x.ts", "export const x = 1;\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const problems = (dirs: readonly string[] = [PLUG]): Promise<string[]> => problemsIn(root, dirs);

const copied = (...files: string[]): string[] => files.map((file) => `${PLUG}/${file}`);

/** The refusal of an import, from `plug/hooks/register.ts`, of a file that is no module of the source. */
const noModule = (specifier: string): string =>
  `plug/hooks/register.ts imports ${specifier}, no module of tools/platform/: a copy holds a .ts file git tracks there, neither a test nor consumers.ts`;

describe("the files of a copy", () => {
  test("a plugin that imports fs.ts alone receives it and the pure.ts it imports", async () => {
    registerImporting('import { fs } from "../lib/platform/fs.ts";');

    expect(await writeCopies(root, [PLUG])).toEqual(copied("fs.ts", "pure.ts"));
    expect(await problems()).toEqual([]);
  });

  test("a plugin that imports git.ts receives process.ts and pure.ts through it", async () => {
    registerImporting('import { git } from "../lib/platform/git.ts";');

    expect(await writeCopies(root, [PLUG])).toEqual(copied("git.ts", "process.ts", "pure.ts"));
    expect(await problems()).toEqual([]);
  });

  test("an import marked type counts, since the typecheck reads the file", async () => {
    registerImporting(
      'import type { lock } from "../lib/platform/lock.ts";',
      'export type { run } from "../lib/platform/process.ts";',
    );

    expect(await writeCopies(root, [PLUG])).toEqual(
      copied("fs.ts", "lock.ts", "process.ts", "pure.ts"),
    );
    expect(await problems()).toEqual([]);
  });

  test("a path a comment names imports nothing", async () => {
    registerImporting(
      'import { pure } from "../lib/platform/pure.ts";',
      '// was imported from "../lib/platform/node.ts"',
      '  // import { git } from "../lib/platform/git.ts";',
      "/**",
      ' * Once imported from "../lib/platform/lock.ts".',
      " */",
      '/* from "../lib/platform/fs.ts" */',
    );

    expect(await writeCopies(root, [PLUG])).toEqual(copied("pure.ts"));
    expect(await problems()).toEqual([]);
  });

  test("a .mts or .cts file imports as a .ts does", async () => {
    write(
      "plug/hooks/a.mts",
      'import { fs } from "../lib/platform/fs.ts";\nexport const a = fs;\n',
    );
    write(
      "plug/hooks/b.cts",
      'import { git } from "../lib/platform/git.ts";\nexport const b = git;\n',
    );

    expect(await writeCopies(root, [PLUG])).toEqual(
      copied("fs.ts", "git.ts", "process.ts", "pure.ts"),
    );
    expect(await problems()).toEqual([]);
  });

  test("a module nothing imports is not copied, and is refused while it lingers, its own imports counting for nothing", async () => {
    expect(await writeCopies(root, [PLUG])).toEqual(copied("pure.ts"));
    copyFileSync(join(root, "tools/platform/git.ts"), join(root, PLUG, "git.ts"));

    expect(await problems()).toEqual([
      `${PLUG}/git.ts is no module plug/ imports, directly or through another: run ${WRITE_COMMAND}, which removes it`,
    ]);
    expect(await writeCopies(root, [PLUG])).toEqual([`${PLUG}/git.ts (removed)`]);
    expect(await problems()).toEqual([]);
  });

  test("a module the plugin imports is refused while its copy lacks it, and each module it imports", async () => {
    registerImporting('import { lock } from "../lib/platform/lock.ts";');

    expect(await problems()).toEqual(
      ["fs.ts", "lock.ts", "pure.ts"].map(
        (file) => `${PLUG}/${file} is missing: run ${WRITE_COMMAND}`,
      ),
    );
  });

  test("refuses an import of a module tools/platform/ does not hold", async () => {
    registerImporting(
      'import { pure } from "../lib/platform/pure.ts";',
      'import { node } from "../lib/platform/node.ts";',
    );
    await writeCopies(root, [PLUG]);

    expect(await problems()).toEqual([noModule("../lib/platform/node.ts")]);
  });

  test.each([
    ["a test", "fs.test.ts", true],
    ["the manifest", "consumers.ts", true],
    ["a file no script is", "README.md", true],
    ["a module git does not track", "wip.ts", false],
  ])(
    "refuses an import of %s of tools/platform/, and copies nothing of it",
    async (_, file, tracked) => {
      write(`tools/platform/${file}`, "export const x = 1;\n");

      if (tracked) track(`tools/platform/${file}`);
      registerImporting(
        'import { pure } from "../lib/platform/pure.ts";',
        `import { x } from "../lib/platform/${file}";`,
      );

      expect(await writeCopies(root, [PLUG])).toEqual(copied("pure.ts"));
      expect(await problems()).toEqual([noModule(`../lib/platform/${file}`)]);
    },
  );

  test("--write removes nothing from a copy while an import names no module of it, a typo maybe", async () => {
    registerImporting('import { git } from "../lib/platform/git.ts";');
    await writeCopies(root, [PLUG]);
    registerImporting('import { git } from "../lib/platform/gti.ts";');

    expect(await writeCopies(root, [PLUG])).toEqual([]);
    expect(readdirSync(join(root, PLUG)).toSorted()).toEqual(["git.ts", "process.ts", "pure.ts"]);
    expect(await problems()).toEqual([noModule("../lib/platform/gti.ts")]);
  });

  test("refuses a listed directory whose copy nothing imports", async () => {
    registerImporting();

    expect(await problems()).toEqual([
      `${PLUG}: nothing in plug/ imports a module of it: remove the directory and its entry in tools/platform/consumers.ts`,
    ]);
  });
});

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

  test("refuses a consumer whose directory does not exist", async () => {
    expect(await problems(["ghost/lib/platform"])).toEqual([
      "ghost/lib/platform: tools/platform/consumers.ts lists it, but ghost/ does not exist; fix the entry",
    ]);
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
    const [problem] = await problems(["plug/hooks/platform"]);

    expect(problem).toStartWith("plug/hooks/platform: a copy lives at <owner>/lib/platform");
  });

  test("refuses a copy directory consumers.ts does not list", async () => {
    write("other/src/platform/pure.ts", "export const pure = 1;\n");

    expect(await problems([])).toEqual([
      `other/src/platform/ holds files tools/platform/consumers.ts lists no copy for: add its entry and run ${WRITE_COMMAND}, or move them out`,
    ]);
  });

  test("refuses a plugin's import of tools/platform/, and a consumer's", async () => {
    write("other/a.ts", 'import { pure } from "./lib/platform/pure.ts";\npure;\n');
    await writeCopies(root, [PLUG, "other/lib/platform"]);
    write("plug/hooks/a.ts", 'import { pure } from "../../tools/platform/pure.ts";\npure;\n');
    write("other/b.ts", 'export { pure } from "../tools/platform/pure.ts";\n');

    const found = await problems([PLUG, "other/lib/platform"]);

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

  test("refuses an import that leaves a plugin whose source is nested, into a sibling or above", async () => {
    write(
      ".claude-plugin/marketplace.json",
      JSON.stringify({
        plugins: [{ source: "./plugins/nested" }, { source: "./plugins/sibling/" }],
      }),
    );

    write("plugins/sibling/y.ts", "export const y = 1;\n");
    write("plugins/nested/b.ts", "export const b = 1;\n");

    write(
      "plugins/nested/a.ts",
      [
        'import { b } from "./b.ts";',
        'import { y } from "../sibling/y.ts";',
        'import { x } from "../../peer/x.ts";',
        "export const all = [b, y, x];",
      ].join("\n"),
    );

    expect(await problems([])).toEqual(
      ["../sibling/y.ts", "../../peer/x.ts"].map(
        (specifier) =>
          `plugins/nested/a.ts imports ${specifier}, outside plugins/nested/: a plugin stands alone once installed, so no import leaves its directory`,
      ),
    );
  });

  test("reads a catalog source ./ as the repository itself, a plugin inside it still its own", async () => {
    write(
      ".claude-plugin/marketplace.json",
      JSON.stringify({ plugins: [{ source: "./" }, { source: "./p" }] }),
    );

    write("p/a.ts", 'import { main } from "../main.ts";\nexport const a = main;\n');

    write(
      "main.ts",
      [
        'import { x } from "./peer/x.ts";',
        'import { z } from "../outside.ts";',
        "export const main = [x, z];",
      ].join("\n"),
    );

    expect(await problems([])).toEqual([
      "main.ts imports ../outside.ts, outside ./: a plugin stands alone once installed, so no import leaves its directory",
      "p/a.ts imports ../main.ts, outside p/: a plugin stands alone once installed, so no import leaves its directory",
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
    registerImporting('import { fs } from "../lib/platform/fs.ts";');
    write("plug/lib/platform/pure.ts", "edited\n");
    write("plug/lib/platform/stray.ts", "stray\n");

    expect(await writeCopies(root, [PLUG])).toEqual([
      ...copied("fs.ts", "pure.ts"),
      "plug/lib/platform/stray.ts (removed)",
    ]);
    expect(await problems()).toEqual([]);
    expect(readFileSync(join(root, "plug/lib/platform/pure.ts"), "utf8")).toBe(
      "export const pure = 1;\n",
    );
  });

  test("the command checks, refuses, then repairs with --write", async () => {
    const modules = readdirSync(join(REPO, "tools/platform")).filter((file) => isModuleName(file));

    for (const file of modules) {
      copyFileSync(join(REPO, "tools/platform", file), join(root, "tools/platform", file));
    }

    mkdirSync(join(root, "scripts/gates"), { recursive: true });
    copyFileSync(
      join(REPO, "scripts/gates/sync-platform.ts"),
      join(root, "scripts/gates/sync-platform.ts"),
    );
    write("tools/platform/consumers.ts", 'export const CONSUMERS = ["plug/lib/platform"];\n');

    const script = join(root, "scripts/gates/sync-platform.ts");
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
    expect(readFileSync(join(root, "plug/lib/platform/pure.ts"))).toEqual(
      readFileSync(join(REPO, "tools/platform/pure.ts")),
    );
  });
});
