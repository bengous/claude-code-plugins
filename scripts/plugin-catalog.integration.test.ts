import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "plugin-catalog.ts");

let root = "";

let repo = "";

let catalog = "";

let env: NodeJS.ProcessEnv;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function manifest(version: string) {
  write(
    join(repo, ".claude-plugin/marketplace.json"),
    JSON.stringify({
      name: "bengous-plugins",
      plugins: [{ name: "example", source: "./different-folder", version }],
    }),
  );
  write(
    join(repo, "different-folder/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "example", version }),
  );
}

function land() {
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Change catalog");
  git(repo, "push", "-q", "origin", "dev");

  return git(repo, "rev-parse", "HEAD");
}

function run(command = "sync", cwd = repo) {
  const result = Bun.spawnSync(
    [process.execPath, join(repo, "scripts/plugin-catalog.ts"), command],
    {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function report() {
  return JSON.parse(
    readFileSync(join(root, "state/claude-plugin-catalog/log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .at(-1)!,
  );
}

function calls() {
  return readFileSync(join(root, "calls"), "utf8");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plugin-catalog-"));
  repo = join(root, "repo");
  catalog = `${repo}.wt/catalog`;
  mkdirSync(repo);
  env = {
    ...process.env,
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: `${root}/bin:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].includes(key))
      delete env[key];
  git(root, "init", "--bare", "-q", "remote");
  git(repo, "init", "-q", "-b", "dev");
  git(repo, "config", "user.name", "Catalog test");
  git(repo, "config", "user.email", "catalog@example.test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", join(root, "remote"));
  write(join(repo, "scripts/plugin-catalog.ts"), readFileSync(SCRIPT, "utf8"));
  manifest("1.0.0");
  write(join(repo, "different-folder/skill.md"), "original\n");
  land();
  git(repo, "worktree", "add", "--detach", catalog, "origin/dev");
  git(repo, "worktree", "lock", "--reason", "claude plugin catalog", catalog);
  write(
    join(root, "claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: { "example@bengous-plugins": [{ scope: "user", version: "1.0.0" }] },
    }),
  );
  write(join(root, "calls"), "");

  for (const name of ["claude", "bun", "notify-send", "systemctl"]) {
    const path = join(root, "bin", name);
    write(
      path,
      `#!/usr/bin/env bash\nset -euo pipefail\necho '${name}' "$@" >> '${root}/calls'\n${name === "claude" ? `if [[ -f '${root}/fail-update' ]]; then echo '{"updateOutcome":"error","message":"update refused"}'; else echo '{"updateOutcome":"updated","oldVersion":"1.0.0","newVersion":"2.0.0"}'; fi` : "exit 0"}\n`,
    );
    chmodSync(path, 0o755);
  }
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("advances a bumped plugin and updates its installed user entry", () => {
  manifest("2.0.0");
  const target = land();
  expect(run().code).toBe(0);
  expect(git(catalog, "rev-parse", "HEAD")).toBe(target);
  expect(report().plugins).toContainEqual({
    name: "example",
    from: "1.0.0",
    to: "2.0.0",
    install: "skipped",
    entry: "updated",
  });
  expect(calls()).toContain("claude plugin update --json --scope user example@bengous-plugins");
  expect(calls()).toContain("restart open ones");
});

test("advances a plugin without a bump and reports the source change", () => {
  write(join(repo, "different-folder/skill.md"), "changed\n");
  land();
  expect(run().code).toBe(0);
  expect(report().plugins[0].entry).toBe("same-version");
  expect(calls()).toContain("changed, same version 1.0.0");
  expect(calls()).not.toContain("claude plugin update");
});

test("advances unrelated files without a notification", () => {
  write(join(repo, "README.md"), "docs\n");
  const target = land();
  expect(run().code).toBe(0);
  expect(git(catalog, "rev-parse", "HEAD")).toBe(target);
  expect(report()).toMatchObject({ catalog: { kind: "moved" }, plugins: [], notified: false });
  expect(calls()).toBe("");
});

test("logs an already current catalog without a notification", () => {
  expect(run().code).toBe(0);
  expect(report()).toMatchObject({ catalog: { kind: "current" }, plugins: [], notified: false });
  expect(calls()).toBe("");
});

test("blocks tracked local edits and names the file and repair", () => {
  write(join(catalog, "different-folder/skill.md"), "keep my edit\n");
  manifest("2.0.0");
  land();
  expect(run().code).toBe(0);
  expect(report().catalog).toMatchObject({ kind: "blocked", files: ["different-folder/skill.md"] });
  expect(readFileSync(join(catalog, "different-folder/skill.md"), "utf8")).toBe("keep my edit\n");
  expect(calls()).toContain("-u critical");
  expect(calls()).toContain("restore .");
});

test("blocks an untracked file that checkout would overwrite", () => {
  write(join(catalog, "different-folder/new.md"), "keep this\n");
  write(join(repo, "different-folder/new.md"), "landed\n");
  land();
  expect(run().code).toBe(0);
  expect(report().catalog.kind).toBe("blocked");
  expect(calls()).toContain("different-folder/new.md");
  expect(calls()).toContain("remove it");
  expect(readFileSync(join(catalog, "different-folder/new.md"), "utf8")).toBe("keep this\n");
});

test("installs dependencies after a lockfile change", () => {
  write(join(repo, "different-folder/package.json"), "{}\n");
  write(join(repo, "different-folder/bun.lock"), "lock\n");
  land();
  expect(run().code).toBe(0);
  expect(report().plugins[0].install).toBe("ok");
  expect(calls()).toContain(`bun install --cwd ${catalog}/different-folder --frozen-lockfile`);
});

test("reports an update failure with a critical notification", () => {
  manifest("2.0.0");
  land();
  write(join(root, "fail-update"), "");
  expect(run().code).toBe(0);
  expect(report().plugins[0].entry.failed).toContain("update refused");
  expect(calls()).toContain("-u critical");
  expect(calls()).toContain("with failures");
});

test("refuses sync without the catalog lock and preserves the main checkout", () => {
  git(repo, "worktree", "unlock", catalog);
  const head = git(repo, "rev-parse", "HEAD");
  const result = run();
  expect(result.code).toBe(1);
  expect(result.err).toContain("No worktree locked with reason: claude plugin catalog");
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("dev");
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(calls()).toBe("");
});

test("setup creates, locks and repairs a missing catalog without moving the main checkout", () => {
  git(repo, "worktree", "unlock", catalog);
  git(repo, "worktree", "remove", catalog);
  expect(run("setup").code).toBe(0);
  expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked claude plugin catalog");
  expect(git(catalog, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/dev"));
  expect(run("setup").code).toBe(0);
  rmSync(catalog, { recursive: true });
  expect(run("setup").code).toBe(0);
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("dev");
});

test("status reports the marketplace, units and absent catalog entries without writes", () => {
  write(
    join(root, "claude/plugins/known_marketplaces.json"),
    JSON.stringify({ "bengous-plugins": { installLocation: catalog } }),
  );
  write(
    join(root, "claude/plugins/installed_plugins.json"),
    JSON.stringify({
      plugins: { "retired@bengous-plugins": [{ scope: "user", version: "1.0.0" }] },
    }),
  );
  const result = run("status");
  expect(result.code).toBe(0);
  expect(result.out).toContain(catalog);
  expect(result.out).toContain("even with origin/dev");
  expect(result.out).toContain("not in catalog");
  expect(calls()).toContain("systemctl --user is-active claude-plugin-catalog.path");
  expect(calls()).not.toContain("claude plugin");
});

test("rechecks origin/dev after notification and processes another landing", () => {
  manifest("2.0.0");
  land();
  write(join(repo, "different-folder/skill.md"), "second landing\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Second landing");
  const target = git(repo, "rev-parse", "HEAD");
  write(
    join(root, "bin/notify-send"),
    `#!/usr/bin/env bash\nset -euo pipefail\ngit -C '${repo}' push -q origin dev\n`,
  );
  expect(run().code).toBe(0);
  expect(git(catalog, "rev-parse", "HEAD")).toBe(target);
  expect(
    readFileSync(join(root, "state/claude-plugin-catalog/log.jsonl"), "utf8").trim().split("\n"),
  ).toHaveLength(2);
});

test("archives a renamed plugin without updating or reinstalling it", () => {
  git(repo, "mv", "different-folder", "archived-folder");
  write(
    join(repo, ".claude-plugin/marketplace.json"),
    JSON.stringify({ name: "bengous-plugins", plugins: [] }),
  );
  land();
  expect(run().code).toBe(0);
  expect(report().plugins[0]).toMatchObject({
    name: "example",
    to: "not in catalog",
    install: "skipped",
    entry: "not-installed",
  });
  expect(calls()).not.toContain("claude plugin update");
});

test("leaves the catalog in place when the installed entries are unreadable, so the next sync replays", () => {
  const installed = join(root, "claude/plugins/installed_plugins.json");
  const valid = readFileSync(installed, "utf8");
  const old = git(catalog, "rev-parse", "HEAD");
  manifest("2.0.0");
  const target = land();
  write(installed, valid.slice(0, 10));
  expect(run().code).toBe(1);
  expect(git(catalog, "rev-parse", "HEAD")).toBe(old);
  write(installed, valid);
  expect(run().code).toBe(0);
  expect(git(catalog, "rev-parse", "HEAD")).toBe(target);
  expect(report().plugins[0].entry).toBe("updated");
});

test("records a notification failure without failing sync", () => {
  manifest("2.0.0");
  land();
  write(
    join(root, "bin/notify-send"),
    "#!/usr/bin/env bash\necho 'no notification bus' >&2\nexit 1\n",
  );
  expect(run().code).toBe(0);
  expect(report()).toMatchObject({ notified: false, notifyError: "no notification bus" });
});

test("ignores harmless untracked files and project-only installations", () => {
  write(join(catalog, "scratch.txt"), "keep\n");
  write(
    join(root, "claude/plugins/installed_plugins.json"),
    JSON.stringify({
      plugins: { "example@bengous-plugins": [{ scope: "project", version: "1.0.0" }] },
    }),
  );
  manifest("2.0.0");
  land();
  expect(run().code).toBe(0);
  expect(report().plugins[0].entry).toBe("not-installed");
  expect(calls()).not.toContain("claude plugin update");
  expect(readFileSync(join(catalog, "scratch.txt"), "utf8")).toBe("keep\n");
});

test("records an unavailable notification executable without losing the report", () => {
  manifest("2.0.0");
  land();
  write(join(root, "bin/notify-send"), "#!/missing/catalog-test-interpreter\n");
  expect(run().code).toBe(0);
  expect(report().notified).toBe(false);
  expect(report().notifyError).toContain("notify-send");
});

test("resolves its own repository when called from another repository", () => {
  const other = join(root, "other");
  mkdirSync(other);
  git(other, "init", "-q");
  write(join(repo, "scripts/plugin-catalog.ts"), readFileSync(SCRIPT, "utf8"));

  const result = Bun.spawnSync(
    [process.execPath, join(repo, "scripts/plugin-catalog.ts"), "sync"],
    { cwd: other, env, stdout: "pipe", stderr: "pipe" },
  );

  expect(result.exitCode).toBe(0);
  expect(report().catalog.kind).toBe("current");
});
