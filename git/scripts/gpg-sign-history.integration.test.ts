/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this harness asserts on the JSON that gpg-sign-history.ts prints on stdout: closed types, or a safety comment per read, would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { $ } from "bun";

const SCRIPT = join(import.meta.dir, "gpg-sign-history.ts");

// Every git and gpg call runs on a throwaway key and config: the developer's own
// key, ~/.gitconfig and system config are out of reach.
let root = "";

let signer = { home: "", fingerprint: "" };

let locked = { home: "", fingerprint: "" };

let repoCount = 0;

let commitCount = 0;

function isolatedEnv(gnupgHome: string) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    GNUPGHOME: gnupgHome,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
}

async function exec(
  cwd: string,
  gnupgHome: string,
  argv: string[],
  extra: Record<string, string> = {},
): Promise<string> {
  const { stdout, stderr, exitCode } = await $`${argv}`
    .cwd(cwd)
    .env({ ...isolatedEnv(gnupgHome), ...extra })
    .quiet()
    .nothrow();

  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed (${exitCode}): ${stderr.toString().trim()}`);
  }

  return stdout.toString().trim();
}

async function makeKey(
  name: string,
  passphrase: string,
): Promise<{ home: string; fingerprint: string }> {
  const home = join(root, `gnupg-${name}`);
  mkdirSync(home, { mode: 0o700 });

  await exec(root, home, [
    "gpg",
    "--batch",
    "--pinentry-mode",
    "loopback",
    "--passphrase",
    passphrase,
    "--quick-gen-key",
    `${name} <${name}@example.com>`,
    "ed25519",
    "sign",
    "never",
  ]);

  const listed = await exec(root, home, ["gpg", "--list-secret-keys", "--with-colons"]);

  const fingerprint =
    listed
      .split("\n")
      .find((line) => line.startsWith("fpr:"))
      ?.split(":")[9] ?? "";

  // A fresh agent holds no passphrase, so the locked key stays locked.
  await exec(root, home, ["gpgconf", "--kill", "gpg-agent"]);

  return { home, fingerprint };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "gpg-sign-history-"));
  mkdirSync(join(root, "home"));
  writeFileSync(join(root, "gitconfig"), "");
  signer = await makeKey("signer", "");
  locked = await makeKey("locked", "secret");
});

afterAll(async () => {
  for (const home of [signer.home, locked.home]) {
    if (home !== "") await $`gpgconf --kill all`.env(isolatedEnv(home)).quiet().nothrow();
  }

  rmSync(root, { recursive: true, force: true });
});

type Repo = { dir: string; key: { home: string; fingerprint: string } };

function git(repo: Repo, ...args: string[]): Promise<string> {
  return exec(repo.dir, repo.key.home, ["git", ...args]);
}

async function makeRepo(key = signer): Promise<Repo> {
  repoCount += 1;
  const dir = join(root, `repo-${repoCount}`);
  mkdirSync(dir);
  const repo = { dir, key };
  await git(repo, "init", "--quiet", "--initial-branch=main");
  await git(repo, "config", "user.name", "Signer");
  await git(repo, "config", "user.email", "signer@example.com");
  await git(repo, "config", "user.signingkey", key.fingerprint);

  return repo;
}

/** One commit on its own file, with an author date and a later committer date in another zone. */
async function commit(repo: Repo, subject: string, signed: boolean): Promise<string> {
  commitCount += 1;
  const day = String((commitCount % 27) + 1).padStart(2, "0");
  writeFileSync(join(repo.dir, `${subject}.txt`), `${subject}\n`);
  await git(repo, "add", `${subject}.txt`);

  await exec(
    repo.dir,
    repo.key.home,
    [
      "git",
      "commit",
      "--quiet",
      signed ? "-S" : "--no-gpg-sign",
      "-m",
      subject,
      "-m",
      "Body line.",
    ],
    {
      GIT_AUTHOR_DATE: `2024-01-${day} 10:00:00 +0100`,
      GIT_COMMITTER_DATE: `2024-02-${day} 12:30:00 -0500`,
    },
  );

  return git(repo, "rev-parse", "HEAD");
}

async function run(
  repo: Repo,
  args: string[],
): Promise<{ exitCode: number; result: Record<string, unknown> }> {
  const { stdout, exitCode } = await $`bun run ${SCRIPT} ${args}`
    .cwd(repo.dir)
    .env(isolatedEnv(repo.key.home))
    .quiet()
    .nothrow();

  const out = stdout.toString().trim();

  try {
    return { exitCode, result: JSON.parse(out) };
  } catch {
    return { exitCode, result: { ok: false, error: `parse-error: ${out}` } };
  }
}

/** Everything that must survive the rewrite, per commit, oldest first; parent hashes change by design. */
async function snapshot(repo: Repo, ref: string): Promise<string[]> {
  const listed = await git(
    repo,
    "log",
    "--reverse",
    "--topo-order",
    "--date=raw",
    "--format=%T|%an|%ae|%ad|%cd|%B%x00",
    ref,
  );

  return listed
    .split("\0")
    .map((record) => record.trim())
    .filter(Boolean);
}

async function verdicts(repo: Repo, ref: string): Promise<string[]> {
  return (await git(repo, "log", "--format=%G?", ref)).split("\n");
}

describe("gpg-sign-history", () => {
  test("a block of unsigned commits at the tip: only they are recreated, dates and work tree kept", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", true);
    const kept = await commit(repo, "b", true);
    await commit(repo, "c", false);
    const tip = await commit(repo, "d", false);
    writeFileSync(join(repo.dir, "a.txt"), "edited, not committed\n");
    writeFileSync(join(repo.dir, "untracked.txt"), "untracked\n");
    const status = await git(repo, "status", "--porcelain");
    const before = await snapshot(repo, "HEAD");

    const audit = await run(repo, ["audit"]);

    expect(audit.result).toMatchObject({
      ok: true,
      step: "audit",
      branch: "main",
      commits: 4,
      unsigned_count: 2,
      rewrite: { count: 2, resigned: 0, merges: 0, foreign_committers: 0 },
      signing: { ready: true },
    });

    const apply = await run(repo, ["apply"]);

    expect(apply.exitCode).toBe(0);
    expect(apply.result).toMatchObject({
      ok: true,
      step: "applied",
      rewritten: 2,
      old_head: tip,
      checks: { ok: true, compared: 2 },
    });
    const backup = String(apply.result.backup_ref);

    expect(backup).toStartWith("gpg-resign-backup-main-");
    expect(await git(repo, "rev-parse", backup)).toBe(tip);
    expect(await git(repo, "rev-parse", "HEAD~2")).toBe(kept);
    expect(await snapshot(repo, "HEAD")).toEqual(before);
    expect(await verdicts(repo, "HEAD")).toEqual(["G", "G", "G", "G"]);
    expect(await git(repo, "status", "--porcelain")).toBe(status);

    const verify = await run(repo, ["verify", backup]);

    expect(verify.result).toMatchObject({
      ok: true,
      step: "verified",
      checks: { ok: true, compared: 2 },
    });
  });

  test("scattered unsigned commits: every commit from the oldest one is recreated, the signed ones re-signed", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", false);
    await commit(repo, "b", true);
    await commit(repo, "c", false);
    await commit(repo, "d", true);
    const before = await snapshot(repo, "HEAD");

    const audit = await run(repo, ["audit"]);

    expect(audit.result).toMatchObject({ unsigned_count: 2, rewrite: { count: 4, resigned: 2 } });

    const apply = await run(repo, ["apply"]);

    expect(apply.result).toMatchObject({ ok: true, rewritten: 4, checks: { ok: true } });
    expect(await snapshot(repo, "HEAD")).toEqual(before);
    expect(await verdicts(repo, "HEAD")).toEqual(["G", "G", "G", "G"]);
  });

  test("an unsigned commit on a merged branch, under a merge resolved by hand", async () => {
    const repo = await makeRepo();
    const base = await commit(repo, "a", true);
    await git(repo, "switch", "--quiet", "-c", "side");
    const sideTip = await commit(repo, "s", false);
    await git(repo, "switch", "--quiet", "main");
    const mainline = await commit(repo, "m", true);
    await git(repo, "merge", "--quiet", "--no-ff", "--no-commit", "side");
    // A file neither parent has: a merge replayed by a rebase would lose it.
    writeFileSync(join(repo.dir, "resolved-by-hand.txt"), "only in the merge\n");
    await git(repo, "add", "resolved-by-hand.txt");
    await git(repo, "commit", "--quiet", "-S", "-m", "Merge side");
    const merge = await git(repo, "rev-parse", "HEAD");
    await commit(repo, "t", true);
    const before = await snapshot(repo, "HEAD");

    expect(await git(repo, "log", "--first-parent", "--format=%H", "HEAD")).not.toContain(sideTip);

    const audit = await run(repo, ["audit"]);

    expect(audit.result).toMatchObject({
      unsigned_count: 1,
      unsigned: [{ hash: sideTip, subject: "s" }],
      rewrite: { count: 3, resigned: 2, merges: 1 },
      other_refs: ["refs/heads/side"],
    });

    const apply = await run(repo, ["apply"]);

    expect(apply.result).toMatchObject({ ok: true, rewritten: 3, checks: { ok: true } });
    expect(await snapshot(repo, "HEAD")).toEqual(before);
    const parents = (await git(repo, "rev-parse", "HEAD~1^1", "HEAD~1^2")).split("\n");

    expect(parents[0]).toBe(mainline);
    expect(parents[1]).not.toBe(sideTip);
    expect(await git(repo, "rev-parse", "HEAD~1^{tree}")).toBe(
      await git(repo, "rev-parse", `${merge}^{tree}`),
    );
    expect(await git(repo, "rev-parse", "HEAD~1^2^{tree}")).toBe(
      await git(repo, "rev-parse", `${sideTip}^{tree}`),
    );
    expect(await git(repo, "merge-base", "HEAD", "side")).toBe(base);
    expect(await verdicts(repo, "HEAD")).toEqual(["G", "G", "G", "G", "G"]);
  });

  test("hooks installed in the repository do not run", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", true);
    await commit(repo, "b", false);
    const marker = join(repo.dir, "post-commit-ran");
    const hooks = join(repo.dir, ".git", "hooks");
    writeFileSync(join(hooks, "prepare-commit-msg"), '#!/bin/sh\necho "added by a hook" >> "$1"\n');
    writeFileSync(join(hooks, "post-commit"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(hooks, "prepare-commit-msg"), 0o755);
    chmodSync(join(hooks, "post-commit"), 0o755);
    const before = await snapshot(repo, "HEAD");

    const apply = await run(repo, ["apply"]);

    expect(apply.result).toMatchObject({ ok: true, rewritten: 1, checks: { ok: true } });
    expect(await snapshot(repo, "HEAD")).toEqual(before);
    expect(await git(repo, "log", "-1", "--format=%B")).not.toContain("added by a hook");
    expect(existsSync(marker)).toBe(false);
  });

  test("a locked key stops the run before the backup and the rewrite", async () => {
    const repo = await makeRepo(locked);
    const tip = await commit(repo, "a", false);
    const refs = await git(repo, "for-each-ref");

    const audit = await run(repo, ["audit"]);

    expect(audit.result).toMatchObject({
      ok: true,
      signing: { ready: false, error: "key-locked" },
    });

    const apply = await run(repo, ["apply"]);

    expect(apply.exitCode).toBe(1);
    expect(apply.result).toMatchObject({
      ok: false,
      step: "apply",
      error: "key-locked",
      backup_ref: null,
    });
    expect(String(apply.result.unlock)).toContain(`-bsau '${locked.fingerprint}'`);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(repo, "for-each-ref")).toBe(refs);
  });

  test("a signature that fails partway through apply leaves the branch and every ref as they were", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", true);
    await commit(repo, "b", false);
    const tip = await commit(repo, "c", false);
    // The preflight and commit b sign; commit c fails, as when the agent's cache expires mid-run.
    const program = join(root, `gpg-fails-on-c-${repoCount}.sh`);

    writeFileSync(
      program,
      `#!/bin/sh\npayload='${program}.payload'\ncat > "$payload"\nif grep -qx c "$payload"; then exit 2; fi\nexec gpg "$@" < "$payload"\n`,
    );
    chmodSync(program, 0o755);
    await git(repo, "config", "gpg.program", program);
    const refs = await git(repo, "for-each-ref");

    const apply = await run(repo, ["apply"]);

    expect(apply.exitCode).toBe(1);
    expect(apply.result).toMatchObject({
      ok: false,
      step: "apply",
      error: "signing-failed",
      backup_ref: null,
    });
    expect(String(apply.result.detail)).toContain("The branch did not move.");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(repo, "for-each-ref")).toBe(refs);
  });

  test("a commit with a header commit-tree cannot write back stops apply before any change", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", true);
    writeFileSync(join(repo.dir, "latin.txt"), "latin\n");
    await git(repo, "add", "latin.txt");
    await git(
      repo,
      "-c",
      "i18n.commitEncoding=ISO-8859-1",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "latin",
    );
    const tip = await git(repo, "rev-parse", "HEAD");
    const refs = await git(repo, "for-each-ref");

    expect(await git(repo, "cat-file", "commit", tip)).toContain("\nencoding ISO-8859-1\n");

    const apply = await run(repo, ["apply"]);

    expect(apply.exitCode).toBe(1);
    expect(apply.result).toMatchObject({ ok: false, step: "apply", error: "unsupported-header" });
    expect(String(apply.result.detail)).toContain(`${tip} encoding`);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(repo, "for-each-ref")).toBe(refs);
  });

  test("a second run gets a backup of its own, and a third finds nothing to sign", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", false);
    const first = await run(repo, ["apply"]);
    await commit(repo, "b", false);
    const second = await run(repo, ["apply"]);

    expect(first.result).toMatchObject({ ok: true });
    expect(second.result).toMatchObject({ ok: true, rewritten: 1 });
    expect(second.result.backup_ref).not.toBe(first.result.backup_ref);

    const audit = await run(repo, ["audit"]);

    expect(audit.result).toMatchObject({ unsigned_count: 0, rewrite: { count: 0 } });
    expect(audit.result.backups).toEqual(
      [first.result.backup_ref, second.result.backup_ref].toSorted(),
    );

    const third = await run(repo, ["apply"]);

    expect(third.result).toMatchObject({ ok: false, error: "nothing-to-sign" });
  });

  test("verify catches a middle commit changed and changed back, which a diff of the tips misses", async () => {
    const repo = await makeRepo();
    const base = await commit(repo, "a", true);
    const middle = await commit(repo, "b", false);
    const tip = await commit(repo, "c", false);
    const index = join(root, `index-${repoCount}`);

    const blob = await exec(repo.dir, repo.key.home, [
      "sh",
      "-c",
      "printf extra | git hash-object -w --stdin",
    ]);

    const withIndex = { GIT_INDEX_FILE: index };
    await exec(repo.dir, repo.key.home, ["git", "read-tree", middle], withIndex);
    await exec(
      repo.dir,
      repo.key.home,
      ["git", "update-index", "--add", "--cacheinfo", `100644,${blob},extra.txt`],
      withIndex,
    );
    const changedTree = await exec(repo.dir, repo.key.home, ["git", "write-tree"], withIndex);

    const dates = async (hash: string): Promise<Record<string, string>> => {
      const [author = "", committer = ""] = (
        await git(repo, "log", "-1", "--date=raw", "--format=%ad%n%cd", hash)
      ).split("\n");

      return { GIT_AUTHOR_DATE: `@${author}`, GIT_COMMITTER_DATE: `@${committer}` };
    };

    const forgedMiddle = await exec(
      repo.dir,
      repo.key.home,
      [
        "sh",
        "-c",
        `git log -1 --format=%B ${middle} | git commit-tree ${changedTree} -p ${base} -S`,
      ],
      await dates(middle),
    );

    const forgedTip = await exec(
      repo.dir,
      repo.key.home,
      [
        "sh",
        "-c",
        `git log -1 --format=%B ${tip} | git commit-tree ${tip}^{tree} -p ${forgedMiddle} -S`,
      ],
      await dates(tip),
    );

    await git(repo, "update-ref", "refs/heads/before", tip);
    await git(repo, "update-ref", "refs/heads/main", forgedTip, tip);

    expect(await git(repo, "diff", "before", "HEAD")).toBe("");

    const verify = await run(repo, ["verify", "before"]);

    expect(verify.exitCode).toBe(1);
    expect(verify.result).toMatchObject({
      ok: false,
      step: "verify",
      error: "verification-failed",
    });
    expect((verify.result.checks as Record<string, unknown>).mismatches).toContainEqual({
      old: middle,
      new: forgedMiddle,
      field: "tree",
    });
  });

  test("refusals: a detached HEAD, an unknown argument, a ref that reads as an option", async () => {
    const repo = await makeRepo();
    const tip = await commit(repo, "a", false);

    expect((await run(repo, ["audit", "--now"])).result).toMatchObject({
      ok: false,
      error: "unknown-argument",
    });
    expect((await run(repo, ["verify", "--output=x"])).result).toMatchObject({
      ok: false,
      error: "invalid-ref",
    });
    await git(repo, "switch", "--quiet", "--detach", tip);
    expect((await run(repo, ["apply"])).result).toMatchObject({
      ok: false,
      error: "detached-head",
    });
  });

  test("a rebase stopped on a conflict reads as an operation in progress, not as a detached HEAD", async () => {
    const repo = await makeRepo();
    await commit(repo, "a", false);
    await git(repo, "switch", "--quiet", "-c", "other");
    writeFileSync(join(repo.dir, "a.txt"), "theirs\n");
    await git(repo, "commit", "--quiet", "--no-gpg-sign", "-am", "theirs");
    await git(repo, "switch", "--quiet", "main");
    writeFileSync(join(repo.dir, "a.txt"), "ours\n");
    await git(repo, "commit", "--quiet", "--no-gpg-sign", "-am", "ours");
    await expect(git(repo, "rebase", "other")).rejects.toThrow("could not apply");

    expect((await run(repo, ["apply"])).result).toMatchObject({
      ok: false,
      error: "operation-in-progress",
      detail: "rebase-merge",
    });
  });
});
