#!/usr/bin/env bun

// gpg-sign-history — Backend for the /git:gpg-sign-history skill.
//
// GPG-signs the unsigned commits reachable from the current branch. Every commit
// from an unsigned one up to the tip is recreated with `git commit-tree`: the
// same tree, parents, author, committer date and message, signed with the
// user's key. A rebase would replay merges and run hooks; commit-tree copies a
// merge's tree as it is and runs no hook. The branch moves only once every new
// commit has been checked against the one it replaces. Every mode prints one
// JSON object on stdout.

import { existsSync } from "node:fs";

import { $ } from "bun";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = "validate" | "audit" | "apply" | "verify";

type Ident = { name: string; email: string; date: string };

export type RawCommit = {
  hash: string;
  tree: string;
  parents: string[];
  author: Ident;
  committer: Ident;
  signed: boolean;
  extraHeaders: string[];
  message: Uint8Array;
};

export type History = { order: string[]; commits: Map<string, RawCommit> };

type Signing = { program: string; key: string };

type SigningError = "key-locked" | "no-secret-key" | "signing-failed";

type Readiness =
  | { ready: true; program: string; key: string }
  | {
      ready: false;
      program: string;
      key: string;
      error: SigningError;
      detail: string;
      unlock: string | null;
    };

export type Field =
  | "tree"
  | "author"
  | "committer-date"
  | "message"
  | "parents"
  | "headers"
  | "kept"
  | "topology";

export type Mismatch = { old: string; new: string; field: Field };

type Checks = {
  ok: boolean;
  compared: number;
  mismatches: Mismatch[];
  unsigned: string[];
  bad_signatures: string[];
  out_of_scope: string[];
};

type Entry = { hash: string; subject: string };

type Success =
  | {
      ok: true;
      step: "audit";
      branch: string;
      head: string;
      commits: number;
      unsigned_count: number;
      unsigned: Entry[];
      rewrite: { count: number; resigned: number; merges: number; foreign_committers: number };
      signing: Readiness;
      sample_signature: { hash: string; signed_at: string; committed_at: string } | null;
      other_refs: string[];
      upstream: { ref: string; rewritten: boolean } | null;
      backups: string[];
    }
  | {
      ok: true;
      step: "applied";
      branch: string;
      old_head: string;
      head: string;
      backup_ref: string;
      rewritten: number;
      checks: Checks;
      signed_at: string | null;
    }
  | { ok: true; step: "verified"; old_head: string; head: string; checks: Checks }
  | { ok: true; step: "usage"; usage: string };

type Failure = {
  ok: false;
  step: Phase;
  error: string;
  detail: string | null;
  unlock: string | null;
  backup_ref: string | null;
  checks: Checks | null;
};

type Result = Success | Failure;

type Checked<T> = { ok: true; value: T } | Failure;

const USAGE = `Usage: gpg-sign-history.ts <mode>

  audit           read-only: the unsigned commits, what a rewrite recreates, whether the key signs
  apply           sign every unsigned commit of the current branch, behind a backup branch
  verify <ref>    compare the current branch, commit by commit, with the history at <ref>`;

const SHOWN_UNSIGNED = 20;

const BACKUP_PREFIX = "gpg-resign-backup-";

// A gpg-error value carries its source in the high byte and its code in the low
// 16 bits: GPG_ERR_BAD_PASSPHRASE, GPG_ERR_NO_PIN_ENTRY, GPG_ERR_CANCELED.
const LOCKED_CODES = new Set([11, 85, 99]);

const GOOD_SIGNATURES = new Set(["G", "U"]);

const OPERATIONS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
] as const;

const NEWLINE = 10;

const IDENT = /^(.*) <([^<>]*)> (\d+ [+-]\d{4})$/u;

const encoder = new TextEncoder();

const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

async function git(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, exitCode } = await $`git ${args}`.quiet().nothrow();

  return { stdout: stdout.toString().trim(), stderr: stderr.toString().trim(), exitCode };
}

async function gitOk(...args: string[]): Promise<string> {
  const result = await git(...args);

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }

  return result.stdout;
}

/** A process fed raw bytes: commit messages are bytes, not necessarily UTF-8 text. */
async function spawn(
  argv: string[],
  input: Uint8Array,
  env: Record<string, string> = {},
): Promise<{ stdout: Uint8Array; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(argv, {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: new Uint8Array(stdout), stderr: stderr.trim(), exitCode };
}

function fail(step: Phase, error: string, detail: string | null = null): Failure {
  return { ok: false, step, error, detail, unlock: null, backup_ref: null, checks: null };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function iso(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Commit objects
// ---------------------------------------------------------------------------

function parseIdent(hash: string, field: string, value: string): Ident {
  const match = IDENT.exec(value);

  if (match === null) throw new Error(`commit ${hash}: unreadable ${field} line: ${value}`);

  return { name: match[1] ?? "", email: match[2] ?? "", date: match[3] ?? "" };
}

function blankLine(raw: Uint8Array): number {
  for (let index = 0; index + 1 < raw.length; index += 1) {
    if (raw[index] === NEWLINE && raw[index + 1] === NEWLINE) return index;
  }

  return -1;
}

/** A raw commit object, as `git cat-file commit` prints it; the message keeps its exact bytes. */
export function parseCommit(hash: string, raw: Uint8Array): RawCommit {
  const split = blankLine(raw);
  const header = decoder.decode(split === -1 ? raw : raw.subarray(0, split));
  const parents: string[] = [];
  const extraHeaders: string[] = [];
  let tree: string | null = null;
  let author: Ident | null = null;
  let committer: Ident | null = null;
  let signed = false;

  for (const line of header.split("\n")) {
    // A multi-line header (gpgsig, mergetag) goes on in lines that start with a space.
    if (line === "" || line.startsWith(" ")) continue;
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);

    switch (key) {
      case "tree": {
        tree = value;
        break;
      }

      case "parent": {
        parents.push(value);
        break;
      }

      case "author": {
        author = parseIdent(hash, key, value);
        break;
      }

      case "committer": {
        committer = parseIdent(hash, key, value);
        break;
      }

      case "gpgsig":
      case "gpgsig-sha256": {
        signed = true;
        break;
      }

      default: {
        extraHeaders.push(key);
      }
    }
  }

  if (tree === null || author === null || committer === null) {
    throw new Error(`commit ${hash}: no tree, author or committer header`);
  }

  const message = split === -1 ? new Uint8Array() : raw.subarray(split + 2);

  return { hash, tree, parents, author, committer, signed, extraHeaders, message };
}

/** `git cat-file --batch` on every hash at once: one process for a whole history. */
async function readCommits(hashes: string[]): Promise<Map<string, RawCommit>> {
  const commits = new Map<string, RawCommit>();

  if (hashes.length === 0) return commits;
  const run = await spawn(["git", "cat-file", "--batch"], encoder.encode(`${hashes.join("\n")}\n`));

  if (run.exitCode !== 0) throw new Error(`git cat-file --batch failed: ${run.stderr}`);
  const out = run.stdout;
  let offset = 0;

  while (offset < out.length) {
    const end = out.indexOf(NEWLINE, offset);

    if (end === -1) throw new Error("git cat-file --batch: output cut short");
    const [hash, type, size] = decoder.decode(out.subarray(offset, end)).split(" ");

    if (hash === undefined || type !== "commit" || size === undefined) {
      throw new Error(`git cat-file --batch: ${hash ?? ""} is not a commit`);
    }

    const start = end + 1;
    const length = Number(size);
    commits.set(hash, parseCommit(hash, out.subarray(start, start + length)));
    offset = start + length + 1;
  }

  return commits;
}

async function loadHistory(tip: string): Promise<History> {
  const listed = await gitOk("rev-list", "--topo-order", "--reverse", tip);
  const order = listed.split("\n").filter(Boolean);

  return { order, commits: await readCommits(order) };
}

function commitOf(history: History, hash: string): RawCommit {
  const commit = history.commits.get(hash);

  if (commit === undefined) throw new Error(`commit ${hash} is not in the history read`);

  return commit;
}

function subject(commit: RawCommit): string {
  return decoder.decode(commit.message).split("\n")[0] ?? "";
}

/**
 * The commits to recreate, parents first: every unsigned commit and every commit
 * that descends from one, since a new parent hash changes the child's hash. The
 * whole graph is walked, merges included, so an unsigned commit on a merged
 * branch is found where a first-parent count such as `HEAD~<n>` misses it.
 */
export function rewriteSet(history: History): string[] {
  const rewritten = new Set<string>();

  for (const hash of history.order) {
    const commit = commitOf(history, hash);

    if (!commit.signed || commit.parents.some((parent) => rewritten.has(parent))) {
      rewritten.add(hash);
    }
  }

  return history.order.filter((hash) => rewritten.has(hash));
}

function sameIdent(left: Ident, right: Ident): boolean {
  return left.name === right.name && left.email === right.email && left.date === right.date;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** What a recreated commit changed besides its signature and its committer's identity. */
export function differences(old: RawCommit, recreated: RawCommit): Field[] {
  const fields: Field[] = [];

  if (old.tree !== recreated.tree) fields.push("tree");

  if (!sameIdent(old.author, recreated.author)) fields.push("author");

  if (old.committer.date !== recreated.committer.date) fields.push("committer-date");

  if (!sameBytes(old.message, recreated.message)) fields.push("message");

  if (old.parents.length !== recreated.parents.length) fields.push("parents");

  if (old.extraHeaders.join(" ") !== recreated.extraHeaders.join(" ")) fields.push("headers");

  return fields;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export function signingError(status: string): SigningError {
  if (/^\[GNUPG:\] (?:INV_SGNR|NO_SGNR)\b/mu.test(status)) return "no-secret-key";

  for (const match of status.matchAll(/^\[GNUPG:\] (?:FAILURE|ERROR) \S+ (\d+)/gmu)) {
    if (LOCKED_CODES.has(Number(match[1]) % 65_536)) return "key-locked";
  }

  return "signing-failed";
}

/** The signature's creation time from `git verify-commit --raw`: the epoch after VALIDSIG's date. */
export function signatureTime(status: string): number | null {
  const match = /^\[GNUPG:\] VALIDSIG \S+ \S+ (\d+)/mu.exec(status);

  return match?.[1] === undefined ? null : Number(match[1]);
}

async function configValue(key: string): Promise<string> {
  return (await git("config", "--get", key)).stdout;
}

async function committerIdent(): Promise<Ident> {
  return parseIdent("HEAD", "committer", await gitOk("var", "GIT_COMMITTER_IDENT"));
}

/** The program and key git itself signs with: `user.signingkey`, else the committer's identity. */
async function signingConfig(step: Phase): Promise<Checked<Signing>> {
  const format = await configValue("gpg.format");

  if (format !== "" && format !== "openpgp") {
    return fail(step, "not-openpgp", `gpg.format is ${format}; this skill signs with GPG only.`);
  }

  const programs = [await configValue("gpg.openpgp.program"), await configValue("gpg.program")];
  const program = programs.find((value) => value !== "") ?? "gpg";
  const configured = await configValue("user.signingkey");

  if (configured !== "") return { ok: true, value: { program, key: configured } };
  const me = await committerIdent();

  return { ok: true, value: { program, key: `${me.name} <${me.email}>` } };
}

/**
 * Signs a throwaway buffer the way git signs a commit, with `--pinentry-mode
 * error` so that a locked key fails at once instead of waiting on a passphrase
 * prompt nobody can answer. Nothing in the repository changes.
 */
async function preflight(config: Signing): Promise<Readiness> {
  const argv = [config.program, "--status-fd=2", "--pinentry-mode", "error", "-bsau", config.key];
  let run: Awaited<ReturnType<typeof spawn>>;

  try {
    run = await spawn(argv, encoder.encode("gpg-sign-history preflight\n"));
  } catch (error) {
    return {
      ready: false,
      ...config,
      error: "signing-failed",
      detail: error instanceof Error ? error.message : String(error),
      unlock: null,
    };
  }

  if (run.exitCode === 0 && /^\[GNUPG:\] SIG_CREATED /mu.test(run.stderr)) {
    return { ready: true, ...config };
  }

  const error = signingError(run.stderr);

  const unlock =
    error === "key-locked"
      ? `printf x | ${shellQuote(config.program)} -bsau ${shellQuote(config.key)} > /dev/null`
      : null;

  return { ready: false, ...config, error, detail: run.stderr, unlock };
}

async function signedAt(hash: string): Promise<number | null> {
  return signatureTime((await git("verify-commit", "--raw", hash)).stderr);
}

/** One commit recreated: git reads the old commit's author and committer date from the environment. */
async function recreate(commit: RawCommit, parents: string[]): Promise<string> {
  const argv = ["git", "commit-tree", commit.tree, ...parents.flatMap((p) => ["-p", p]), "-S"];

  const run = await spawn(argv, commit.message, {
    GIT_AUTHOR_NAME: commit.author.name,
    GIT_AUTHOR_EMAIL: commit.author.email,
    GIT_AUTHOR_DATE: `@${commit.author.date}`,
    GIT_COMMITTER_DATE: `@${commit.committer.date}`,
  });

  if (run.exitCode !== 0) {
    throw new Error(`git commit-tree for ${commit.hash} failed: ${run.stderr}`);
  }

  return decoder.decode(run.stdout).trim();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function badSignatures(hashes: string[]): Promise<string[]> {
  if (hashes.length === 0) return [];

  const run = await spawn(
    ["git", "log", "--no-walk=unsorted", "--stdin", "--format=%H %G?"],
    encoder.encode(`${hashes.join("\n")}\n`),
  );

  if (run.exitCode !== 0) throw new Error(`git log --format=%G? failed: ${run.stderr}`);

  const verdicts = new Map(
    decoder
      .decode(run.stdout)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", verdict = ""] = line.split(" ");

        return [hash, verdict];
      }),
  );

  return hashes.filter((hash) => !GOOD_SIGNATURES.has(verdicts.get(hash) ?? ""));
}

/**
 * Pairs each commit of the new history with the one it replaces, walking both
 * graphs from their tips parent by parent, and compares every pair: a tree
 * changed in a middle commit and changed back later fails here, where a diff of
 * the two tips sees nothing. The commits that `rewriteSet` names on the old side
 * must all be recreated and no other one.
 */
async function verifyHistories(oldTip: string, newTip: string): Promise<Checks> {
  const before = await loadHistory(oldTip);
  const after = await loadHistory(newTip);
  const expected = new Set(rewriteSet(before));
  const paired = new Map<string, string>();
  const mismatches: Mismatch[] = [];
  const outOfScope: string[] = [];
  const recreated: string[] = [];
  const queue: [string, string][] = [[oldTip, newTip]];

  for (let pair = queue.pop(); pair !== undefined; pair = queue.pop()) {
    const [oldHash, newHash] = pair;
    const known = paired.get(oldHash);

    if (known !== undefined) {
      if (known !== newHash) mismatches.push({ old: oldHash, new: newHash, field: "topology" });
      continue;
    }

    paired.set(oldHash, newHash);

    // Equal hashes mean equal ancestry: nothing below this pair changed.
    if (oldHash === newHash) {
      if (expected.has(oldHash)) mismatches.push({ old: oldHash, new: newHash, field: "kept" });
      continue;
    }

    if (!expected.has(oldHash)) outOfScope.push(oldHash);
    const old = commitOf(before, oldHash);
    const now = commitOf(after, newHash);
    recreated.push(newHash);

    for (const field of differences(old, now)) {
      mismatches.push({ old: oldHash, new: newHash, field });
    }

    for (const [index, parent] of old.parents.entries()) {
      const counterpart = now.parents[index];

      if (counterpart !== undefined) queue.push([parent, counterpart]);
    }
  }

  for (const hash of expected) {
    if (!paired.has(hash)) mismatches.push({ old: hash, new: "", field: "topology" });
  }

  const unsigned = after.order.filter((hash) => !commitOf(after, hash).signed);
  const bad = await badSignatures(recreated);

  return {
    ok:
      mismatches.length === 0 &&
      unsigned.length === 0 &&
      bad.length === 0 &&
      outOfScope.length === 0,
    compared: recreated.length,
    mismatches,
    unsigned,
    bad_signatures: bad,
    out_of_scope: outOfScope,
  };
}

// ---------------------------------------------------------------------------
// Repository state
// ---------------------------------------------------------------------------

async function requireHead(step: Phase): Promise<Checked<string>> {
  const top = await git("rev-parse", "--show-toplevel");

  if (top.exitCode !== 0) return fail(step, "not-a-git-repo", top.stderr);
  const head = await git("rev-parse", "--verify", "--quiet", "HEAD^{commit}");

  if (head.exitCode !== 0) return fail(step, "no-commits");

  if ((await gitOk("rev-parse", "--is-shallow-repository")) === "true") {
    return fail(step, "shallow-repository", "Fetch the whole history first: git fetch --unshallow");
  }

  return { ok: true, value: head.stdout };
}

async function requireBranch(step: Phase): Promise<Checked<{ branch: string; head: string }>> {
  const head = await requireHead(step);

  if (!head.ok) return head;

  // A rebase detaches HEAD: look for it first, or it reads as a detached HEAD to switch away from.
  for (const operation of OPERATIONS) {
    if (existsSync(await gitOk("rev-parse", "--git-path", operation))) {
      return fail(step, "operation-in-progress", operation);
    }
  }

  const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");

  if (branch.exitCode !== 0) return fail(step, "detached-head", "Switch to the branch to sign.");

  return { ok: true, value: { branch: branch.stdout, head: head.value } };
}

/** The first commits of the rewrite: whatever contains one of them still holds the old history. */
function rewriteRoots(history: History, rewrite: string[]): string[] {
  const set = new Set(rewrite);

  return rewrite.filter((hash) => !commitOf(history, hash).parents.some((p) => set.has(p)));
}

async function otherRefs(branch: string, roots: string[]): Promise<string[]> {
  if (roots.length === 0) return [];

  const listed = await gitOk(
    "for-each-ref",
    "--format=%(refname)",
    ...roots.map((root) => `--contains=${root}`),
    "refs/heads",
    "refs/tags",
  );

  return listed
    .split("\n")
    .filter(
      (ref) =>
        ref !== "" &&
        ref !== `refs/heads/${branch}` &&
        !ref.startsWith(`refs/heads/${BACKUP_PREFIX}`),
    );
}

async function upstreamOf(roots: string[]): Promise<{ ref: string; rewritten: boolean } | null> {
  const upstream = await git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");

  if (upstream.exitCode !== 0) return null;

  for (const root of roots) {
    if ((await git("merge-base", "--is-ancestor", root, "@{u}")).exitCode === 0) {
      return { ref: upstream.stdout, rewritten: true };
    }
  }

  return { ref: upstream.stdout, rewritten: false };
}

/** Each run gets its own backup, so a second run never meets the first one's name. */
async function createBackup(branch: string, tip: string): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/gu, "")
    .slice(0, 14);

  const base = `${BACKUP_PREFIX}${branch.replaceAll(/[^A-Za-z0-9._-]/gu, "-")}-${stamp}`;

  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`;
    // An empty old value makes update-ref refuse a ref that already exists.
    const created = await git("update-ref", `refs/heads/${name}`, tip, "");

    if (created.exitCode === 0) return name;
  }

  throw new Error(`no free backup name after ${base}`);
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function auditMode(): Promise<Result> {
  const repo = await requireBranch("audit");

  if (!repo.ok) return repo;
  const { branch, head } = repo.value;
  const config = await signingConfig("audit");

  if (!config.ok) return config;
  const history = await loadHistory(head);
  const rewrite = rewriteSet(history);
  const unsigned = history.order.filter((hash) => !commitOf(history, hash).signed);
  const roots = rewriteRoots(history, rewrite);
  const me = await committerIdent();
  const rewritten = rewrite.map((hash) => commitOf(history, hash));
  const newestSigned = history.order.findLast((hash) => commitOf(history, hash).signed);
  let sample: { hash: string; signed_at: string; committed_at: string } | null = null;

  if (newestSigned !== undefined) {
    const time = await signedAt(newestSigned);
    const committed = Number(commitOf(history, newestSigned).committer.date.split(" ")[0]);

    if (time !== null) {
      sample = { hash: newestSigned, signed_at: iso(time), committed_at: iso(committed) };
    }
  }

  const backups = await gitOk(
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${BACKUP_PREFIX}*`,
  );

  return {
    ok: true,
    step: "audit",
    branch,
    head,
    commits: history.order.length,
    unsigned_count: unsigned.length,
    unsigned: unsigned
      .toReversed()
      .slice(0, SHOWN_UNSIGNED)
      .map((hash) => ({ hash, subject: subject(commitOf(history, hash)) })),
    rewrite: {
      count: rewrite.length,
      resigned: rewritten.filter((commit) => commit.signed).length,
      merges: rewritten.filter((commit) => commit.parents.length > 1).length,
      foreign_committers: rewritten.filter(
        (commit) => commit.committer.name !== me.name || commit.committer.email !== me.email,
      ).length,
    },
    signing: await preflight(config.value),
    sample_signature: sample,
    other_refs: await otherRefs(branch, roots),
    upstream: await upstreamOf(roots),
    backups: backups.split("\n").filter(Boolean),
  };
}

async function applyMode(): Promise<Result> {
  const repo = await requireBranch("apply");

  if (!repo.ok) return repo;
  const { branch, head } = repo.value;
  const history = await loadHistory(head);
  const rewrite = rewriteSet(history);

  if (rewrite.length === 0) {
    return fail("apply", "nothing-to-sign", "Every commit reachable from HEAD is signed.");
  }

  const unsupported = rewrite.flatMap((hash) =>
    commitOf(history, hash).extraHeaders.map((header) => `${hash} ${header}`),
  );

  if (unsupported.length > 0) {
    const detail = `${unsupported.join("\n")}\n\ngit commit-tree cannot write these headers back.`;

    return fail("apply", "unsupported-header", detail);
  }

  const config = await signingConfig("apply");

  if (!config.ok) return config;
  const readiness = await preflight(config.value);

  if (!readiness.ready) {
    return { ...fail("apply", readiness.error, readiness.detail), unlock: readiness.unlock };
  }

  const replaced = new Map<string, string>();

  try {
    for (const hash of rewrite) {
      const commit = commitOf(history, hash);
      const parents = commit.parents.map((parent) => replaced.get(parent) ?? parent);
      replaced.set(hash, await recreate(commit, parents));
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return fail("apply", "signing-failed", `${detail}\n\nThe branch did not move.`);
  }

  const newHead = replaced.get(head) ?? head;
  const checks = await verifyHistories(head, newHead);

  if (!checks.ok) {
    const detail = "The branch did not move: the new commits differ from the ones they replace.";

    return { ...fail("apply", "verification-failed", detail), checks };
  }

  const backup = await createBackup(branch, head);

  const moved = await git(
    "update-ref",
    "-m",
    `gpg-sign-history: signed ${rewrite.length} commits`,
    `refs/heads/${branch}`,
    newHead,
    head,
  );

  if (moved.exitCode !== 0) {
    return { ...fail("apply", "branch-moved", moved.stderr), backup_ref: backup, checks };
  }

  const time = await signedAt(newHead);

  return {
    ok: true,
    step: "applied",
    branch,
    old_head: head,
    head: newHead,
    backup_ref: backup,
    rewritten: rewrite.length,
    checks,
    signed_at: time === null ? null : iso(time),
  };
}

async function verifyMode(ref: string): Promise<Result> {
  if (ref.startsWith("-")) return fail("verify", "invalid-ref", ref);
  const head = await requireHead("verify");

  if (!head.ok) return head;
  const old = await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);

  if (old.exitCode !== 0) return fail("verify", "unknown-ref", ref);
  const checks = await verifyHistories(old.stdout, head.value);

  if (!checks.ok) return { ...fail("verify", "verification-failed"), checks };

  return { ok: true, step: "verified", old_head: old.stdout, head: head.value, checks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function rejectExtra(step: Phase, rest: string[]): Failure | null {
  if (rest.length === 0) return null;

  return fail(step, "unknown-argument", `${rest.join(" ")}\n\n${USAGE}`);
}

async function main(): Promise<Result> {
  const args = Bun.argv.slice(2);
  const mode = args[0] ?? "";

  switch (mode) {
    case "":
    case "-h":
    case "--help":
    case "help": {
      return { ok: true, step: "usage", usage: USAGE };
    }

    case "audit": {
      return rejectExtra("audit", args.slice(1)) ?? (await auditMode());
    }

    case "apply": {
      return rejectExtra("apply", args.slice(1)) ?? (await applyMode());
    }

    case "verify": {
      const ref = args[1];

      if (ref === undefined) return fail("verify", "missing-ref", USAGE);

      return rejectExtra("verify", args.slice(2)) ?? (await verifyMode(ref));
    }

    default: {
      return fail("validate", "unknown-mode", `${mode}\n\n${USAGE}`);
    }
  }
}

if (import.meta.main) {
  let result: Result;

  try {
    result = await main();
  } catch (error) {
    result = fail(
      "validate",
      "unexpected-failure",
      error instanceof Error ? error.message : String(error),
    );
  }

  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}
