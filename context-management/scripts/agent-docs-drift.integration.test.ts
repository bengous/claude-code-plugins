import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { classifyPath, groupByZone, LARGE_WINDOW, parseLog } from "./agent-docs-drift.ts";

const SCRIPT = join(import.meta.dir, "agent-docs-drift.ts");

// Isolated from the developer's git config: signing, hooks or log.showSignature there would
// change what these tests create and read.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }

  return result.stdout.toString().trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-docs-drift-test-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");

  return dir;
}

function commit(dir: string, files: Record<string, string>, subject = "change"): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", subject);

  return git(dir, "rev-parse", "--short", "HEAD");
}

function audit(dir: string) {
  const result = Bun.spawnSync([process.execPath, SCRIPT], {
    cwd: dir,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("classifyPath", () => {
  test("names the zone of a changed path", () => {
    expect(classifyPath("package.json")).toBe("(root)");
    expect(classifyPath("src/index.ts")).toBe("src");
    expect(classifyPath("src/shared/kernel/paths.ts")).toBe("src/shared/kernel");
    expect(classifyPath("src/shared/kernel/deep/paths.ts")).toBe("src/shared/kernel");
    expect(classifyPath(".claude/rules/skill-commands.md")).toBe(".claude/rules");
    expect(classifyPath(".github/ci.yml")).toBe(".github");
    expect(classifyPath("scripts/build/run.sh")).toBe("scripts");
  });
});

const record = (header: string, pairs: string) => `${header}\0${pairs}`;

describe("parseLog", () => {
  test("reads status/path pairs, keeps a commit without paths, collects deletions", () => {
    const log =
      record("a".repeat(40) + "aaaaaaaempty", "") +
      record("b".repeat(40) + "bbbbbbbdel", '\nD\0lib/q"uote.ts\0') +
      record("c".repeat(40) + "cccccccadd", "\nA\0lib/new\nline.ts\0M\0lib/x.ts\0");

    expect(parseLog(log)).toEqual([
      { hash: "a".repeat(40), short: "aaaaaaa", subject: "empty", files: [], removed: [] },
      {
        hash: "b".repeat(40),
        short: "bbbbbbb",
        subject: "del",
        files: ['lib/q"uote.ts'],
        removed: ['lib/q"uote.ts'],
      },
      {
        hash: "c".repeat(40),
        short: "ccccccc",
        subject: "add",
        files: ["lib/new\nline.ts", "lib/x.ts"],
        removed: [],
      },
    ]);
  });
});

describe("groupByZone", () => {
  test("counts a commit once per zone, busiest zone first, then by name", () => {
    const zones = groupByZone([
      { hash: "a", short: "a", subject: "", files: ["lib/x.ts", "lib/y.ts"], removed: [] },
      { hash: "b", short: "b", subject: "", files: ["lib/x.ts", "docs/guide.md"], removed: [] },
      { hash: "c", short: "c", subject: "", files: ["app/main.ts"], removed: [] },
    ]);

    expect(zones).toEqual([
      { zone: "lib", shorts: ["a", "b"], keyFiles: ["x.ts", "y.ts"] },
      { zone: "app", shorts: ["c"], keyFiles: ["main.ts"] },
      { zone: "docs", shorts: ["b"], keyFiles: ["guide.md"] },
    ]);
  });
});

describe("agent-docs-drift", () => {
  test("a commit touching only .claude/rules/ is the baseline", () => {
    const dir = repo();
    commit(dir, { "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# Agents\n" });
    commit(dir, { "src/app/core/a.ts": "1\n" });
    const rules = commit(dir, { ".claude/rules/core.md": "# Core\n" });
    const after = commit(dir, { "src/app/core/b.ts": "1\n" });

    const { exitCode, stdout } = audit(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`- Baseline: \`${rules}\``);
    expect(stdout).toContain("- Commits since baseline: 1");
    expect(stdout).toContain("- `.claude/rules/core.md`");
    expect(stdout).toContain(`| src/app/core | 1 | ${after} | b.ts |`);
    expect(stdout).toContain("One read-only subagent audits the whole audit set");
  });

  test("an AGENTS.md edit moves the baseline past the CLAUDE.md import stub", () => {
    const dir = repo();
    commit(dir, { "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": "# v1\n" });
    commit(dir, { "lib/a.ts": "1\n" });
    const agents = commit(dir, { "AGENTS.md": "# v2\n" });
    commit(dir, { "lib/b.ts": "1\n" });

    const { stdout } = audit(dir);

    expect(stdout).toContain(`- Baseline: \`${agents}\``);
    expect(stdout).toContain("- Commits since baseline: 1");
  });

  test("paths come raw whatever they hold, deletions are listed, a subdirectory cwd works", () => {
    const dir = repo();
    commit(dir, { "AGENTS.md": "# Agents\n", ".claude/rules/sécurité.md": "# S\n" });
    commit(dir, { "lib/new\nline.ts": "1\n", 'lib/q"uote.ts': "1\n" });
    git(dir, "rm", "-q", 'lib/q"uote.ts');
    const deletion = commit(dir, {}, "drop");
    commit(dir, {}, "empty");

    const { exitCode, stdout } = audit(join(dir, "lib"));

    expect(exitCode).toBe(0);
    expect(stdout).toContain("- `.claude/rules/sécurité.md`");
    expect(stdout).toContain("- Commits since baseline: 3");
    expect(stdout).toContain(`## Removed paths\n\n- \`lib/q"uote.ts\` (${deletion})`);
    expect(stdout).toContain('new\nline.ts, q"uote.ts');
    expect(stdout).not.toContain("\\303");
  });

  test("log.showSignature does not leak into the baseline or the window", () => {
    const dir = repo();
    const key = join(dir, "key");
    Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key]);
    git(dir, "config", "gpg.format", "ssh");
    git(dir, "config", "user.signingkey", key);
    git(dir, "config", "commit.gpgsign", "true");
    git(dir, "config", "log.showSignature", "true");
    const base = commit(dir, { "AGENTS.md": "# Agents\n", ".gitignore": "key*\n" });
    const after = commit(dir, { "lib/a.ts": "1\n" });

    const { exitCode, stdout } = audit(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`- Baseline: \`${base}\``);
    expect(stdout).toContain(`| lib | 1 | ${after} | a.ts |`);
    expect(stdout).not.toContain("signature");
  });

  test("Doc files at HEAD ignores the index and the working tree", () => {
    const dir = repo();
    commit(dir, { "AGENTS.md": "# Agents\n" });
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    git(dir, "add", "CLAUDE.md");
    rmSync(join(dir, "AGENTS.md"));

    const { stdout } = audit(dir);

    expect(stdout).toContain("- `AGENTS.md`");
    expect(stdout).not.toContain("- `CLAUDE.md`");
  });

  test("an empty window says so, and prints no protocol", () => {
    const dir = repo();
    commit(dir, { "AGENTS.md": "# Agents\n" });

    const { exitCode, stdout } = audit(dir);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("An empty window does not prove the docs are current.");
    expect(stdout).not.toContain("## Protocol");
  });

  test("a window above the threshold is summarized by zone before the commit list", () => {
    const dir = repo();
    commit(dir, { "AGENTS.md": "# Agents\n" });

    const hashes = Array.from({ length: LARGE_WINDOW + 1 }, (_, index) =>
      commit(dir, { [`${index % 2 === 0 ? "lib" : "app"}/f${index}.ts`]: `${index}\n` }),
    );

    const { stdout } = audit(dir);

    expect(stdout).toContain(`> Large window: ${LARGE_WINDOW + 1} commits.`);
    expect(stdout.indexOf("## Changed zones")).toBeLessThan(stdout.indexOf("## Commits"));
    expect(stdout).toContain("Read no file yet.");

    for (const hash of hashes) expect(stdout).toContain(`- \`${hash}\` change`);
  });

  test("a repository without a doc file fails with the reason", () => {
    const dir = repo();
    commit(dir, { "lib/a.ts": "1\n" });

    const { exitCode, stderr } = audit(dir);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("agent-docs-drift: no file of the doc set is tracked at HEAD");
  });
});
