import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type PluginDir,
  type PluginName,
  pluginDirAt,
  pluginNameIn,
} from "./lib/plugin-sources.ts";
import { claudeArgv, pluginTable, sourceTable, table } from "./try-plugin.ts";

let scratch = "";

function dirAt(path: string): PluginDir {
  const dir = pluginDirAt(path);

  if (dir === null) throw new Error(`not a directory: ${path}`);

  return dir;
}

/** The branded name a row carries; the brand's only constructor reads the disk. */
function name(plugin: string): PluginName {
  mkdirSync(join(scratch, plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(scratch, plugin, ".claude-plugin", "plugin.json"), "{}\n");

  const root = pluginDirAt(scratch);

  if (root === null) throw new Error("no scratch directory");

  const branded = pluginNameIn(root, plugin);

  if (branded === null) throw new Error(`not a plugin: ${plugin}`);

  return branded;
}

describe("try-plugin", () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "try-plugin-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test("table pads on display width, the em dash counting as one column", () => {
    expect(
      table([
        ["REF", "VERSION"],
        ["dev", "—"],
        ["fix/long-name", "1.0.0"],
      ]),
    ).toEqual(["REF            VERSION", "dev            —", "fix/long-name  1.0.0"]);
  });

  test("pluginTable puts the plugins with work outside dev first", () => {
    const lines = pluginTable([
      { name: name("zeta"), devVersion: "1.0.0", installedVersion: null, outsideDev: true },
      { name: name("alpha"), devVersion: "2.0.0", installedVersion: "1.9.0", outsideDev: false },
      { name: name("beta"), devVersion: "3.0.0", installedVersion: null, outsideDev: true },
    ]);

    expect(lines).toEqual([
      "PLUGIN  INSTALLED  DEV    OUTSIDE DEV",
      "beta    —          3.0.0  yes",
      "zeta    —          1.0.0  yes",
      "alpha   1.9.0      2.0.0",
    ]);
  });

  test("sourceTable names where each source sits, and dashes a ref level with dev", () => {
    const main = dirAt(scratch);
    const worktree = join(scratch, ".claude", "worktrees", "agent-1");

    mkdirSync(worktree, { recursive: true });

    expect(
      sourceTable(
        [
          {
            ref: "dev",
            version: "6.0.0",
            lastCommit: "2026-09-13",
            ahead: 0,
            kind: "checkout",
            dir: main,
          },
          {
            ref: "squash/vellum-grill",
            version: "6.0.0",
            lastCommit: "2026-09-13",
            ahead: 0,
            kind: "checkout",
            dir: dirAt(worktree),
          },
          {
            ref: "fix/meta-tools-cleanup",
            version: "6.0.0",
            lastCommit: "2026-09-13",
            ahead: 3,
            kind: "branch",
            hasLocalBranch: true,
          },
        ],
        main,
      ),
    ).toEqual([
      "SOURCE                  VERSION  WHERE                               LAST COMMIT  AHEAD",
      "dev                     6.0.0    main checkout                       2026-09-13   —",
      "squash/vellum-grill     6.0.0    worktree .claude/worktrees/agent-1  2026-09-13   —",
      "fix/meta-tools-cleanup  6.0.0    no worktree                         2026-09-13   3",
    ]);
  });

  test("claudeArgv keeps the flags try-plugin.sh launched with, in order", () => {
    expect(claudeArgv(["/repo/vellum", "/repo/github-flow"], ["--model", "opus"])).toEqual([
      "claude",
      "--debug",
      "--permission-mode",
      "default",
      "--plugin-dir",
      "/repo/vellum",
      "--plugin-dir",
      "/repo/github-flow",
      "--model",
      "opus",
    ]);
  });
});
