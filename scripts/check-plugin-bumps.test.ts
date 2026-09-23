import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type CommitId,
  commitAt,
  type PushedRef,
  parsePushedRefs,
  type Unbumped,
  unbumped,
} from "./check-plugin-bumps.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";

const SCRIPT = join(import.meta.dir, "check-plugin-bumps.ts");

const ZERO = "0".repeat(40);

let root = "";

let repo: PluginDir;

let base: CommitId;

interface Entry {
  name: string;
  source: string;
}

const EXAMPLE: Entry = { name: "example", source: "./example" };

const ORCHESTRATION: Entry = { name: "claude-orchestration", source: "./orchestration/" };

function write(path: string, content: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

  if (result.exitCode !== 0) throw new Error(result.stderr.toString());

  return result.stdout.toString().trim();
}

function catalog(entries: Entry[]) {
  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({ name: "bengous-plugins", plugins: entries }),
  );
}

function manifest(dir: string, version: string) {
  write(`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name: dir, version }));
}

function commit(message: string): CommitId {
  git("add", "-A");
  git("commit", "-qm", message);

  return commitAt(repo, "HEAD");
}

/** The plugins `head` leaves unbumped since `base`, brands dropped so a literal can state them. */
function found(head: CommitId): { name: string; source: string; version: string }[] {
  return unbumped(repo, base, head).map(({ name, source, version }: Unbumped) => ({
    name,
    source,
    version,
  }));
}

/** The lines `parsePushedRefs` keeps, brands dropped so a literal can state them. */
function pushed(
  lines: string,
): { local: string | null; remoteRef: string; remote: string | null }[] {
  return parsePushedRefs(repo, lines).map(({ local, remoteRef, remote }: PushedRef) => ({
    local,
    remoteRef,
    remote,
  }));
}

function run(args: string[], stdin = "") {
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    cwd: repo,
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  return { code: result.exitCode, err: result.stderr.toString() };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "check-plugin-bumps-"));
  mkdirSync(join(root, "repo"));
  const dir = pluginDirAt(join(root, "repo"));

  if (dir === null) throw new Error(`no scratch repo under ${root}`);
  repo = dir;
  git("init", "-q", "-b", "dev");
  // A CI runner carries no identity, and signing is on globally here.
  git("config", "user.name", "Bump test");
  git("config", "user.email", "bumps@example.test");
  git("config", "commit.gpgsign", "false");
  catalog([EXAMPLE, ORCHESTRATION]);
  manifest("example", "1.0.0");
  manifest("orchestration", "1.0.0");
  write("example/skill.md", "original\n");
  write("orchestration/skill.md", "original\n");
  write("README.md", "docs\n");
  base = commit("Base");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("unbumped", () => {
  test("names a plugin whose directory changed while its version did not", () => {
    write("example/skill.md", "changed\n");

    expect(found(commit("Change example"))).toEqual([
      { name: "example", source: "example", version: "1.0.0" },
    ]);
  });

  test("passes the same change with a bump", () => {
    write("example/skill.md", "changed\n");
    manifest("example", "1.1.0");

    expect(found(commit("Change and bump example"))).toEqual([]);
  });

  test("passes a change outside every plugin directory", () => {
    write("README.md", "more docs\n");
    write("docs/guide.md", "guide\n");

    expect(found(commit("Docs"))).toEqual([]);
  });

  test("passes a plugin the base does not hold", () => {
    catalog([EXAMPLE, ORCHESTRATION, { name: "fresh", source: "./fresh" }]);
    manifest("fresh", "0.1.0");
    write("fresh/skill.md", "new\n");

    expect(found(commit("Add fresh"))).toEqual([]);
  });

  test("passes a plugin retired from the catalog", () => {
    mkdirSync(join(repo, "archive"));
    renameSync(join(repo, "example"), join(repo, "archive/example"));
    write("archive/example/skill.md", "retired\n");
    catalog([ORCHESTRATION]);

    expect(found(commit("Retire example"))).toEqual([]);
  });

  test("passes a bump followed by another change", () => {
    manifest("example", "1.1.0");
    commit("Bump example");
    write("example/skill.md", "changed after the bump\n");

    expect(found(commit("Change example again"))).toEqual([]);
  });

  test("names the marketplace entry, not the directory", () => {
    write("orchestration/skill.md", "changed\n");

    expect(found(commit("Change orchestration"))).toEqual([
      { name: "claude-orchestration", source: "orchestration", version: "1.0.0" },
    ]);
  });
});

describe("parsePushedRefs", () => {
  test("keeps a line whose remote ref is main", () => {
    write("example/skill.md", "changed\n");
    const head = commit("Change example");

    expect(pushed(`refs/heads/dev ${head} refs/heads/main ${base}\n`)).toEqual([
      { local: head, remoteRef: "refs/heads/main", remote: base },
    ]);
  });

  test("ignores a line to another ref without resolving its oids", () => {
    const unknown = "1".repeat(40);

    expect(pushed(`refs/heads/dev ${base} refs/heads/dev ${unknown}\n`)).toEqual([]);
  });

  test("reads the zero oid of a deletion as null", () => {
    expect(pushed(`(delete) ${ZERO} refs/heads/main ${base}\n`)).toEqual([
      { local: null, remoteRef: "refs/heads/main", remote: base },
    ]);
  });

  test("refuses a malformed line, naming it", () => {
    const line = `refs/heads/dev ${base} refs/heads/main`;

    expect(() => parsePushedRefs(repo, `${line}\n`)).toThrow(line);
  });

  test("refuses a remote oid this repository does not have", () => {
    const unknown = "1".repeat(40);

    expect(() =>
      parsePushedRefs(repo, `refs/heads/dev ${base} refs/heads/main ${unknown}\n`),
    ).toThrow(
      `refs/heads/main is at ${unknown} on the remote, a commit this repository does not have: fetch origin first`,
    );
  });
});

describe("commitAt", () => {
  test("names a ref git cannot resolve", () => {
    expect(() => commitAt(repo, "no-such-ref")).toThrow("no-such-ref");
  });
});

describe("the command", () => {
  test("--pre-push refuses a push to main that leaves a plugin unbumped, naming it", () => {
    write("example/skill.md", "changed\n");
    const head = commit("Change example");
    const result = run(["--pre-push"], `refs/heads/dev ${head} refs/heads/main ${base}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `example: ./example changed since ${base.slice(0, 7)}, version still 1.0.0`,
    );
  });

  test("--pre-push lets the same change through on a push to dev", () => {
    write("example/skill.md", "changed\n");
    const head = commit("Change example");

    expect(run(["--pre-push"], `refs/heads/dev ${head} refs/heads/dev ${base}\n`)).toEqual({
      code: 0,
      err: "",
    });
  });

  test("--pre-push refuses a push to main whose remote oid is null", () => {
    const result = run(["--pre-push"], `refs/heads/dev ${base} refs/heads/main ${ZERO}\n`);

    expect(result.code).toBe(1);
    expect(result.err).toContain("refs/heads/main does not exist on the remote (null remote oid)");
  });

  test("compares two refs given by hand", () => {
    write("orchestration/skill.md", "changed\n");
    commit("Change orchestration");
    const result = run([base, "HEAD"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `claude-orchestration: ./orchestration changed since ${base.slice(0, 7)}, version still 1.0.0`,
    );
  });
});
