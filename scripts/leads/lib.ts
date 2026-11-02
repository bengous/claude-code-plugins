/**
 * The leads pipeline's shared parts (`docs/repo-ops/leads.md`): the facts of a dependency update Renovate landed on
 * `dev`, read from git, npm and the update's release notes; the ledger, markers and labels the pipeline keeps on
 * GitHub; the fire that starts a scan task. `gate.ts` and `scan.ts` are its commands. Every process and the network
 * come in through a `Context`, so the tests drive them with fakes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

import { isRecord, isStringArray, stringField } from "../../agent-hooks/json.ts";
import { writeAtomicSync } from "../../tools/platform/fs.ts";
import { gitSync } from "../../tools/platform/git.ts";
import {
  type RunOptions,
  type RunResult,
  runSync,
  type TextOutput,
} from "../../tools/platform/process.ts";
import { messageOf } from "../../tools/platform/pure.ts";

export const RENOVATE_EMAIL = "29139614+renovate[bot]@users.noreply.github.com";

const RENOVATE_LOGIN = "renovate[bot]";

/** The comment and issue authors whose text the pipeline reads as its own records. */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const TREE = "origin/dev";

const SPAWN_TIMEOUT_MS = 120_000;

const NETWORK_TIMEOUT_MS = 60_000;

const NOTES_MAX = 2000;

/** How long a scan holds `lead:in-progress` before another scan, or the gate's re-fire, may take its issue. */
export const CLAIM_TTL_MS = 6 * 60 * 60 * 1000;

export const DRY_RUN_VARIABLE = "LEADS_DRY_RUN";

export const LEADS_DIR = ".leads";

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

export function parseJson(text: string): Json {
  // SAFETY: JSON.parse yields JSON values only; every reader narrows them through isRecord before use.
  return JSON.parse(text) as Json;
}

export function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Processes, GitHub, the network
// ---------------------------------------------------------------------------

export interface Proc {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** A finished process as the pipeline reads it: past its timeout 124, a program the PATH lacks 127, as a shell says. */
export function procOf(program: string, result: RunResult): Proc {
  switch (result.kind) {
    case "exited":
      return { code: result.code, out: result.stdout, err: result.stderr };
    case "timedOut":
      return {
        code: 124,
        out: result.stdout,
        err: `${program}: no answer within ${result.timeoutMs / 1000} s`,
      };
    case "missing":
      return { code: 127, out: "", err: `${program} is not on the PATH` };
  }
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** GitHub's REST API, as `gh api` serves it: the cloud's GitHub proxy refuses GraphQL. */
export interface GitHub {
  /** One call's JSON, null for an empty body; throws on a status other than 2xx. */
  call(method: Method, path: string, body?: Json): Json;
  /** Every item of every page of a list endpoint, in order. */
  list(path: string): readonly Json[];
}

export function ghApi(cwd: string): GitHub {
  const api = (args: readonly string[], stdin?: string): string => {
    const options: RunOptions & TextOutput = { cwd, timeoutMs: SPAWN_TIMEOUT_MS };
    const argv = ["gh", "api", ...args] as const;

    const result = procOf(
      "gh",
      runSync(argv, stdin === undefined ? options : { ...options, stdin }),
    );

    if (result.code !== 0) {
      throw new Error(
        `gh api ${args.join(" ")}: ${oneLine(`${result.err} ${result.out}`).slice(0, 500)}`,
      );
    }

    return result.out;
  };

  return {
    call(method, path, body) {
      const out =
        body === undefined
          ? api(["-X", method, path])
          : api(["-X", method, path, "--input", "-"], JSON.stringify(body));

      return out.trim() === "" ? null : parseJson(out);
    },
    list(path) {
      return api(["--paginate", path, "--jq", ".[]"])
        .split("\n")
        .flatMap((line) => (line.trim() === "" ? [] : [parseJson(line)]));
    },
  };
}

/** How much of a write's body a dry run prints: the output must stay under what a session shows inline. */
const DRY_RUN_BODY_MAX = 300;

/** Prints each write in place of sending it, its body cut short; reads go through. A write answers issue 0. */
export function dryRun(gh: GitHub, print: (line: string) => void): GitHub {
  return {
    call(method, path, body) {
      if (method === "GET") return gh.call(method, path);

      const shown = body === undefined ? "" : ` ${clip(JSON.stringify(body), DRY_RUN_BODY_MAX)}`;

      print(`dry run: ${method} ${path}${shown}`);

      return { number: 0, html_url: "(dry run)" };
    },
    list: (path) => gh.list(path),
  };
}

/** The first line a command prints in a dry run, so the model reads its `dry run:` lines as intended. */
export function announceDryRun(ctx: Context): void {
  if (isDryRun(ctx.env)) {
    ctx.print(
      `dry run: ${DRY_RUN_VARIABLE}=1, so each GitHub write and fire is printed, not made; report it as a dry run`,
    );
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where the pipeline runs and what it reaches the world through. */
export interface Context {
  /** The checkout's top level, which holds `.leads/`. */
  readonly root: string;
  /** `owner/name` of the repository the issues go to. */
  readonly repo: string;
  readonly env: Env;
  readonly gh: GitHub;
  /** Runs git in the checkout, its end as it came: some calls read the code alone. */
  readonly git: (args: readonly string[]) => Proc;
  /** npm's stdout for `args`, run in an empty directory of its own; null when npm is absent, fails or times out. */
  readonly npm: (args: readonly string[]) => string | null;
  readonly fetch: Fetch;
  readonly print: (line: string) => void;
  readonly warn: (line: string) => void;
}

export function isDryRun(env: Env): boolean {
  return env[DRY_RUN_VARIABLE] === "1";
}

/** `owner/name`, the last two segments of a remote URL: SSH, HTTPS, or the cloud's local proxy. */
export function slugOf(remote: string): string {
  const parts = remote
    .trim()
    .replace(/\.git$/u, "")
    .split(/[/:]/u)
    .filter((part) => part !== "");

  const [owner, name] = parts.slice(-2);

  if (owner === undefined || name === undefined)
    throw new Error(`no owner/name in remote ${remote}`);

  return `${owner}/${name}`;
}

export function git(ctx: Context, ...args: string[]): string {
  const result = ctx.git(args);

  if (result.code !== 0)
    throw new Error(`git ${args.join(" ")}: ${firstLine(result.err || result.out)}`);

  return result.out.trimEnd();
}

function gitIn(cwd: string): (args: readonly string[]) => Proc {
  return (args) => procOf("git", gitSync(args, { cwd, timeoutMs: SPAWN_TIMEOUT_MS }));
}

function npmCli(args: readonly string[]): string | null {
  const cwd = mkdtempSync(join(tmpdir(), "leads-npm-"));

  try {
    const result = procOf("npm", runSync(["npm", ...args], { cwd, timeoutMs: NETWORK_TIMEOUT_MS }));

    return result.code === 0 ? result.out : null;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The context of a command run from a checkout: `LEADS_REPO` or `origin`'s slug, `LEADS_DRY_RUN=1` printing writes. */
export function contextOf(env: Env, cwd: string): Context {
  const top = gitIn(cwd)(["rev-parse", "--show-toplevel"]);

  if (top.code !== 0) throw new Error(`${cwd} is not in a git checkout: ${firstLine(top.err)}`);

  const root = top.out.trim();
  const remote = gitIn(root)(["remote", "get-url", "origin"]);
  const named = env["LEADS_REPO"];

  if ((named === undefined || named === "") && remote.code !== 0) {
    throw new Error(`LEADS_REPO is unset and origin has no URL: ${firstLine(remote.err)}`);
  }

  const gh = ghApi(root);

  return {
    root,
    repo: named === undefined || named === "" ? slugOf(remote.out) : named,
    env,
    gh: isDryRun(env) ? dryRun(gh, printLine) : gh,
    git: gitIn(root),
    npm: npmCli,
    fetch: (url, init) => fetch(url, init),
    print: printLine,
    warn: warnLine,
  };
}

function printLine(line: string): void {
  console.log(line);
}

function warnLine(line: string): void {
  console.error(`leads: ${line}`);
}

export function leadsPath(ctx: Context, name: string): string {
  return join(ctx.root, LEADS_DIR, name);
}

/** Writes a file of `.leads/` whole, the directory created first. */
export function writeLeadsFile(ctx: Context, name: string, content: string): void {
  writeAtomicSync(leadsPath(ctx, name), content, { mkdir: true });
}

/** Removes a file of `.leads/` an earlier run left; one that is not there is fine. */
export function removeLeadsFile(ctx: Context, name: string): void {
  rmSync(leadsPath(ctx, name), { force: true });
}

// ---------------------------------------------------------------------------
// Renovate's commits and the versions they changed
// ---------------------------------------------------------------------------

export interface Commit {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
}

/**
 * Brings `origin/dev` up to date with its whole history. The refspec is explicit because a single-branch clone, as a
 * cloud session may hold, fetches `dev` without writing `origin/dev`; a shallow clone is deepened.
 */
export function fetchDev(ctx: Context): void {
  const shallow = git(ctx, "rev-parse", "--is-shallow-repository") === "true";

  git(
    ctx,
    "fetch",
    "--quiet",
    ...(shallow ? ["--unshallow"] : []),
    "origin",
    "+refs/heads/dev:refs/remotes/origin/dev",
  );
}

/** Renovate's commits on `origin/dev` since `since`, oldest first. */
export function renovateCommits(ctx: Context, since: string): Commit[] {
  return git(
    ctx,
    "log",
    TREE,
    "--reverse",
    "-F",
    `--author=${RENOVATE_EMAIL}`,
    `--since=${since}`,
    "--format=%H%x09%cI%x09%s",
  )
    .split("\n")
    .flatMap((line) => {
      const [sha = "", date = "", ...subject] = line.split("\t");

      return sha === "" ? [] : [{ sha, date, subject: subject.join("\t") }];
    });
}

/** Whether `sha` is a commit of Renovate's that `origin/dev` holds. */
export function isRenovateCommit(ctx: Context, sha: string): boolean {
  if (!/^[0-9a-f]{40}$/u.test(sha)) return false;

  return (
    ctx.git(["merge-base", "--is-ancestor", sha, TREE]).code === 0 &&
    ctx.git(["log", "-1", "--format=%ae", sha]).out.trim() === RENOVATE_EMAIL
  );
}

export function commitOf(ctx: Context, sha: string): Commit {
  const [full = "", date = "", ...subject] = git(
    ctx,
    "log",
    "-1",
    "--format=%H%x09%cI%x09%s",
    sha,
  ).split("\t");

  return { sha: full, date, subject: subject.join("\t") };
}

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

export interface VersionChange {
  readonly package: string;
  readonly from: string;
  readonly to: string;
}

export interface ManifestDiff {
  readonly manifest: string;
  readonly changes: readonly VersionChange[];
}

export interface ManifestChange extends VersionChange {
  readonly manifests: readonly string[];
}

/** The versions a manifest's dependency sections changed; a dependency added or removed is no update. */
export function versionChanges(before: Json, after: Json): VersionChange[] {
  if (!isRecord(before) || !isRecord(after)) return [];

  return SECTIONS.flatMap((section) => {
    const old = before[section];
    const now = after[section];

    if (!isRecord(old) || !isRecord(now)) return [];

    return Object.keys(now).flatMap((name) => {
      const from = stringField(old, name);
      const to = stringField(now, name);

      return from === undefined || to === undefined || from === to
        ? []
        : [{ package: name, from, to }];
    });
  });
}

/** One change per package with every manifest it changed in, the first manifest's versions kept. */
export function groupChanges(diffs: readonly ManifestDiff[]): ManifestChange[] {
  const grouped = new Map<string, { change: VersionChange; manifests: string[] }>();

  for (const { manifest, changes } of diffs) {
    for (const change of changes) {
      const known = grouped.get(change.package);

      if (known === undefined) grouped.set(change.package, { change, manifests: [manifest] });
      else if (!known.manifests.includes(manifest)) known.manifests.push(manifest);
    }
  }

  return [...grouped.values()].map(({ change, manifests }) => ({ ...change, manifests }));
}

function jsonAt(ctx: Context, rev: string, path: string): Json {
  const shown = ctx.git(["show", `${rev}:${path}`]);

  if (shown.code !== 0) return null;

  try {
    return parseJson(shown.out);
  } catch {
    return null;
  }
}

/** The dependency versions `sha` changed in its `package.json` files, against its first parent. */
export function manifestChanges(ctx: Context, sha: string): ManifestChange[] {
  const files = git(ctx, "diff-tree", "-r", "--name-only", `${sha}^`, sha)
    .split("\n")
    .filter((file) => file === "package.json" || file.endsWith("/package.json"));

  return groupChanges(
    files.map((manifest) => ({
      manifest,
      changes: versionChanges(jsonAt(ctx, `${sha}^`, manifest), jsonAt(ctx, sha, manifest)),
    })),
  );
}

// ---------------------------------------------------------------------------
// The size of an update
// ---------------------------------------------------------------------------

export type UpdateType = "major" | "minor" | "patch" | "prerelease" | "pin";

export interface Bump {
  readonly updateType: UpdateType;
  /** A `0.x` version whose minor changed, which semver lets break. */
  readonly preOne: boolean;
}

const RANGE_PREFIX = /^(?:\^|~|>=|<=|>|<|=|v)+/u;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;

export function bareVersion(version: string): string {
  return version.trim().replace(RANGE_PREFIX, "");
}

/** An update's size; a version that is not semver reads `major`, so a stronger model looks at it. */
export function bumpOf(from: string, to: string): Bump {
  const bareFrom = bareVersion(from);
  const bareTo = bareVersion(to);

  if (bareFrom === bareTo) return { updateType: "pin", preOne: false };

  const before = SEMVER.exec(bareFrom);
  const after = SEMVER.exec(bareTo);

  if (before === null || after === null) return { updateType: "major", preOne: false };

  if (before[4] !== undefined || after[4] !== undefined) {
    return { updateType: "prerelease", preOne: false };
  }

  const [major, minor] = [Number(before[1]), Number(before[2])];

  if (Number(after[1]) !== major) return { updateType: "major", preOne: false };

  if (Number(after[2]) !== minor) return { updateType: "minor", preOne: major === 0 };

  return { updateType: "patch", preOne: false };
}

// ---------------------------------------------------------------------------
// Where the repository uses a package
// ---------------------------------------------------------------------------

export interface Usage {
  readonly codeSites: number;
  readonly docSites: number;
  readonly files: readonly string[];
  /** `path:line: text` of the sites whose line reads like a workaround or a pending upstream fix. */
  readonly markers: readonly string[];
}

export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".toml",
  ".sh",
]);

const DOC_EXTENSIONS = new Set([".md"]);

const MARKER = /workaround|upstream|bug in|until|TODO|FIXME|HACK/iu;

const NOT_USAGE = [
  ":(exclude,glob)**/*.lock",
  ":(exclude,glob)**/CHANGELOG.md",
  ":(exclude,glob)**/*.jsonl",
  ":(exclude)archive",
];

const MAX_FILES = 20;

const MAX_MARKERS = 10;

const MARKER_TEXT_MAX = 120;

/** `git grep`'s lines on a tree, `<tree>:<path>:<line>:<text>`, read back. */
export function hitsOf(output: string, tree: string): Hit[] {
  const prefix = `${tree}:`;

  return output.split("\n").flatMap((line) => {
    if (!line.startsWith(prefix)) return [];

    const match = /^(.+?):(\d+):(.*)$/u.exec(line.slice(prefix.length));

    return match === null
      ? []
      : [{ path: match[1] ?? "", line: Number(match[2]), text: match[3] ?? "" }];
  });
}

const NAME_BEFORE = /[A-Za-z0-9_$@/.-]/u;

const NAME_AFTER = /[A-Za-z0-9_$-]/u;

/** Whether `needle` stands in `text` as a whole name: not inside a longer name, a scope or a path segment. */
export function standsAlone(text: string, needle: string): boolean {
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) {
    const before = text[index - 1] ?? "";
    const after = text[index + needle.length] ?? "";

    if (!NAME_BEFORE.test(before) && !NAME_AFTER.test(after)) return true;
  }

  return false;
}

/** What names a package in code: its name, or for `@types/x` the module `x` in quotes. */
export function needlesOf(pkg: string): readonly string[] {
  const typed = /^@types\/(.+)$/u.exec(pkg)?.[1];

  return typed === undefined ? [pkg] : [`"${typed}:`, `"${typed}"`, `'${typed}:`, `'${typed}'`];
}

function grep(ctx: Context, needles: readonly string[], excludes: readonly string[]): Hit[] {
  const result = ctx.git([
    "grep",
    "-n",
    "-I",
    "-F",
    ...needles.flatMap((needle) => ["-e", needle]),
    TREE,
    "--",
    ".",
    ...excludes,
  ]);

  if (result.code === 1) return [];

  if (result.code !== 0) throw new Error(`git grep ${needles.join(" ")}: ${firstLine(result.err)}`);

  return hitsOf(result.out, TREE);
}

/** The executables a package's `bin` field names, read from `npm view <pkg>@<version> bin --json`. */
export function binsOf(pkg: string, viewed: string): readonly string[] {
  if (viewed.trim() === "") return [];

  const bin = parseJson(viewed);

  if (isRecord(bin)) return Object.keys(bin);

  return bin === null || !isStringArray([bin]) ? [] : [pkg.replace(/^@[^/]+\//u, "")];
}

/** A manifest line that declares a dependency on `name`, which names it without running it. */
function isDependencyLine(text: string, name: string): boolean {
  return new RegExp(`^\\s*"${RegExp.escape(name)}"\\s*:`, "u").test(text);
}

/** The usage of the package's executables: in a manifest's scripts, or in any file that is not a doc. */
export function toolHits(hits: readonly Hit[], bin: string): Hit[] {
  return hits.filter((hit) => {
    const extension = extname(hit.path);

    if (DOC_EXTENSIONS.has(extension) || !standsAlone(hit.text, bin)) return false;

    return !hit.path.endsWith("package.json") || !isDependencyLine(hit.text, bin);
  });
}

export function usageOf(hits: readonly Hit[]): Usage {
  const seen = new Set<string>();
  const code: Hit[] = [];
  const docs: Hit[] = [];

  for (const hit of hits) {
    const key = `${hit.path}:${hit.line}`;
    const extension = extname(hit.path);

    if (seen.has(key)) continue;

    seen.add(key);

    if (CODE_EXTENSIONS.has(extension)) code.push(hit);
    else if (DOC_EXTENSIONS.has(extension)) docs.push(hit);
  }

  return {
    codeSites: code.length,
    docSites: docs.length,
    files: [...new Set(code.map((hit) => hit.path))].toSorted().slice(0, MAX_FILES),
    markers: [...code, ...docs]
      .flatMap((hit) =>
        MARKER.test(hit.text)
          ? [`${hit.path}:${hit.line}: ${clip(hit.text.trim(), MARKER_TEXT_MAX)}`]
          : [],
      )
      .slice(0, MAX_MARKERS),
  };
}

/** Where `origin/dev` uses `pkg`: imports and names, and its executables in scripts and configs. */
export function usage(ctx: Context, pkg: string, version: string): Usage {
  const needles = needlesOf(pkg);
  const named = grep(ctx, needles, [":(exclude,glob)**/package.json", ...NOT_USAGE]);

  const direct = needles[0] === pkg ? named.filter((hit) => standsAlone(hit.text, pkg)) : named;

  const viewed = ctx.npm(["view", `${pkg}@${bareVersion(version)}`, "bin", "--json"]);

  const tools = binsOf(pkg, viewed ?? "").flatMap((bin) =>
    toolHits(grep(ctx, [bin], NOT_USAGE), bin),
  );

  return usageOf([...direct, ...tools]);
}

// ---------------------------------------------------------------------------
// Release notes and the typed API
// ---------------------------------------------------------------------------

export interface RenovatePr {
  readonly number: number;
  readonly body: string;
}

/** The pull requests GitHub lists for a commit that are Renovate's own: a `feature/` one can list it too. */
export function renovatePrsOf(pulls: Json): RenovatePr[] {
  if (!Array.isArray(pulls)) return [];

  const items: readonly Json[] = pulls;

  return items.flatMap((pull) => {
    if (!isRecord(pull)) return [];

    const user = pull["user"];
    const head = pull["head"];
    const number = pull["number"];
    const login = isRecord(user) ? stringField(user, "login") : undefined;
    const ref = isRecord(head) ? stringField(head, "ref") : undefined;

    return login === RENOVATE_LOGIN &&
      ref?.startsWith("renovate/") === true &&
      Number.isInteger(number)
      ? [{ number: Number(number), body: stringField(pull, "body") ?? "" }]
      : [];
  });
}

/** The Renovate pull request that landed `sha`, null when it landed by branch or GitHub cannot say. */
export function renovatePrOf(ctx: Context, sha: string): RenovatePr | null {
  try {
    return renovatePrsOf(ctx.gh.call("GET", `repos/${ctx.repo}/commits/${sha}/pulls`))[0] ?? null;
  } catch (error) {
    ctx.warn(
      `no pull request read for ${sha.slice(0, 7)}, notes from npm or the changelog: ${messageOf(error)}`,
    );

    return null;
  }
}

export interface PrNotes {
  readonly compare: string | null;
  readonly text: string;
}

const COMPARE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/[\w.@%+-]+\.\.\.[\w.@%+-]+$/u;

/** A GitHub compare URL, or null for anything else: the link an issue carries must be one. */
export function compareUrl(url: string | null | undefined): string | null {
  const github = url?.replace(/^https:\/\/redirect\.github\.com\//u, "https://github.com/");

  return github !== undefined && COMPARE.test(github) ? github : null;
}

function cleanNotes(text: string): string {
  return text
    .replaceAll("&#8203;", "")
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll("https://redirect.github.com/", "https://github.com/")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The notes Renovate's pull request body carries for `pkg`: its table row proves the update, its details hold them. */
export function parseRenovatePrBody(body: string, pkg: string): PrNotes | null {
  const named = RegExp.escape(pkg);

  const row = new RegExp(
    `^\\|\\s*\\[${named}\\]\\([^)]*\\)\\s*\\|\\s*\\[\`[^\`]+\` → \`[^\`]+\`\\]`,
    "mu",
  );

  if (!row.test(body)) return null;

  for (const match of body.matchAll(
    /<details>\s*<summary>([^<]*)<\/summary>([\s\S]*?)<\/details>/gu,
  )) {
    if (!(match[1] ?? "").trim().endsWith(`(${pkg})`)) continue;

    const section = match[2] ?? "";
    const compare = /\[Compare Source\]\((https:\/\/[^)\s]+)\)/u.exec(section)?.[1];

    return { compare: compareUrl(compare), text: cleanNotes(section) };
  }

  return null;
}

export interface Notes {
  /** `pr#<n>`, `changelog` (npm diff), `raw` (raw.githubusercontent.com) or `none`. */
  readonly source: string;
  readonly compare: string | null;
  readonly text: string;
}

const NO_NOTES: Notes = { source: "none", compare: null, text: "" };

function npmDiff(
  ctx: Context,
  pkg: string,
  from: string,
  to: string,
  paths: readonly string[],
): string | null {
  return ctx.npm([
    "diff",
    `--diff=${pkg}@${bareVersion(from)}`,
    `--diff=${pkg}@${bareVersion(to)}`,
    ...paths,
  ]);
}

/** The lines a diff adds, its headers aside. */
export function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

function containsVersion(line: string, version: string): boolean {
  return new RegExp(`(?<![\\d.])v?${RegExp.escape(version)}(?![\\d.]*\\d)`, "u").test(line);
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s/u.test(line);
}

/** A changelog's entries from the heading of `to` down to the heading of `from`. */
export function changelogSection(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => isHeading(line) && containsVersion(line, to));

  if (start === -1) return "";

  const end = lines.findIndex(
    (line, index) => index > start && isHeading(line) && containsVersion(line, from),
  );

  return lines
    .slice(start, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/** `owner/name` of a GitHub repository URL as npm's `repository` field writes it. */
export function githubRepoOf(url: string): string | null {
  const match =
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/u.exec(url) ??
    /^github:([\w.-]+)\/([\w.-]+)$/u.exec(url);

  return match === null ? null : `${match[1]}/${match[2]}`;
}

interface Repository {
  readonly slug: string;
  readonly directory: string;
}

function repositoryOf(ctx: Context, pkg: string, to: string): Repository | null {
  const viewed = ctx.npm(["view", `${pkg}@${bareVersion(to)}`, "repository", "--json"]);

  if (viewed === null || viewed.trim() === "") return null;

  // npm's `repository` is an object with a `url`, or the URL alone.
  const parsed = parseJson(viewed);
  const repository = isRecord(parsed) ? parsed : { url: parsed };
  const slug = githubRepoOf(stringField(repository, "url") ?? "");
  const directory = stringField(repository, "directory") ?? "";

  return slug === null ? null : { slug, directory: directory.replaceAll(/^\.?\/+|\/+$/gu, "") };
}

async function rawChangelog(
  ctx: Context,
  pkg: string,
  from: string,
  to: string,
): Promise<Notes | null> {
  const repository = repositoryOf(ctx, pkg, to);

  if (repository === null) return null;

  const tagsOf = (version: string) => [`v${version}`, version, `${pkg}@${version}`];
  const bareFrom = bareVersion(from);
  const bareTo = bareVersion(to);
  const fromTags = tagsOf(bareFrom);

  // A monorepo keeps a package's changelog in its directory, which npm's `repository` often leaves out:
  // mermaid's is packages/mermaid/CHANGELOG.md.
  const directories = [
    ...(repository.directory === "" ? [] : [repository.directory]),
    `packages/${pkg.replace(/^@[^/]+\//u, "")}`,
  ];

  const files = [
    ...new Set(directories).values().map((directory) => `${directory}/CHANGELOG.md`),
    "CHANGELOG.md",
  ];

  for (const [index, tag] of tagsOf(bareTo).entries()) {
    for (const file of files) {
      const url = `https://raw.githubusercontent.com/${repository.slug}/${encodeURIComponent(tag)}/${file}`;

      try {
        // oxlint-disable-next-line no-await-in-loop -- the tags are tried in order, and the first found ends the search.
        const response = await ctx.fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });

        if (!response.ok) continue;

        // oxlint-disable-next-line no-await-in-loop -- the body of the one response that answered.
        const section = changelogSection(await response.text(), bareFrom, bareTo);

        if (section === "") continue;

        return {
          source: "raw",
          compare: compareUrl(
            `https://github.com/${repository.slug}/compare/${encodeURIComponent(fromTags[index] ?? "")}...${encodeURIComponent(tag)}`,
          ),
          text: clip(section, NOTES_MAX),
        };
      } catch (error) {
        ctx.warn(`${url}: ${messageOf(error)}`);
      }
    }
  }

  return null;
}

/**
 * What an update brings, from the first source that answers: Renovate's pull request, the changelog lines npm's diff
 * adds, the changelog at the release's tag. The text, at most 2000 characters, is for the gate and the scan to read,
 * never for an issue.
 */
export async function releaseNotes(
  ctx: Context,
  change: VersionChange,
  pr: RenovatePr | null,
): Promise<Notes> {
  const fromPr = pr === null ? null : parseRenovatePrBody(pr.body, change.package);

  if (pr !== null && fromPr !== null && fromPr.text !== "") {
    return {
      source: `pr#${pr.number}`,
      compare: fromPr.compare,
      text: clip(fromPr.text, NOTES_MAX),
    };
  }

  const diff = npmDiff(ctx, change.package, change.from, change.to, [
    "CHANGELOG.md",
    "CHANGES.md",
    "HISTORY.md",
  ]);

  const added = diff === null ? "" : addedLines(diff).join("\n").trim();

  if (added !== "") return { source: "changelog", compare: null, text: clip(added, NOTES_MAX) };

  return (await rawChangelog(ctx, change.package, change.from, change.to)) ?? NO_NOTES;
}

export interface Types {
  readonly source: "npm-diff" | "unavailable";
  readonly files: number;
  readonly added: readonly string[];
  /** The declarations whose name no added line declares again: gone, not changed. */
  readonly removed: readonly string[];
  readonly deprecated: readonly string[];
}

export interface TypedDiff {
  readonly types: Types;
  /** npm's diff of the `.d.ts` files, empty when unavailable. */
  readonly diff: string;
}

const UNAVAILABLE: Types = {
  source: "unavailable",
  files: 0,
  added: [],
  removed: [],
  deprecated: [],
};

function isDeclaration(line: string): boolean {
  const text = line.trim();

  return text !== "" && !/^(?:\/\*\*?|\*\/?|\/\/)/u.test(text);
}

/** The declarations a `.d.ts` diff adds and removes, and the deprecations it adds. */
export function readTypedDiff(diff: string): Types {
  const lines = diff.split("\n");

  const changed = (sign: string) =>
    lines
      .filter((line) => line.startsWith(sign) && !line.startsWith(sign.repeat(3)))
      .map((line) => line.slice(1).trim());

  const added = changed("+");
  const redeclared = new Set(added.flatMap((line) => declaredName(line) ?? []));

  // A changed signature is its old line removed and its new one added: only a name no added line declares is gone.
  const removed = changed("-").filter((line) => {
    const name = declaredName(line);

    return name !== null && !redeclared.has(name);
  });

  return {
    source: "npm-diff",
    files: lines.filter((line) => line.startsWith("diff --git ")).length,
    added: added.filter((line) => isDeclaration(line)).slice(0, 20),
    removed: removed.slice(0, 20),
    deprecated: added.filter((line) => line.includes("@deprecated")).slice(0, 10),
  };
}

/** The name a `.d.ts` line declares, a binding or a member; null for a line that declares none. */
export function declaredName(line: string): string | null {
  const match =
    /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/u.exec(
      line,
    ) ?? /^(?:readonly\s+)?(?:static\s+)?([A-Za-z_$][\w$]*)\??\s*[:(<]/u.exec(line);

  return match?.[1] ?? null;
}

export function typedDiff(ctx: Context, change: VersionChange): TypedDiff {
  const diff = npmDiff(ctx, change.package, change.from, change.to, ["**/*.d.ts"]);

  return diff === null ? { types: UNAVAILABLE, diff: "" } : { types: readTypedDiff(diff), diff };
}

// ---------------------------------------------------------------------------
// The facts of one update
// ---------------------------------------------------------------------------

export interface Facts {
  readonly sha: string;
  readonly subject: string;
  readonly package: string;
  readonly from: string;
  readonly to: string;
  readonly updateType: UpdateType;
  readonly preOne: boolean;
  readonly manifests: readonly string[];
  readonly usage: Usage;
  readonly notes: Notes;
  readonly types: Types;
}

export type BaseFacts = Omit<Facts, "types">;

export type SitedFacts = Omit<BaseFacts, "notes">;

/** The update's size and where the repository uses it: what git and npm's registry answer fast. */
export function sitedFacts(ctx: Context, commit: Commit, change: ManifestChange): SitedFacts {
  return {
    sha: commit.sha,
    subject: commit.subject,
    package: change.package,
    from: change.from,
    to: change.to,
    ...bumpOf(change.from, change.to),
    manifests: change.manifests,
    usage: usage(ctx, change.package, change.to),
  };
}

/** Everything but the typed diff. */
export async function baseFacts(
  ctx: Context,
  commit: Commit,
  change: ManifestChange,
  pr: RenovatePr | null,
): Promise<BaseFacts> {
  return { ...sitedFacts(ctx, commit, change), notes: await releaseNotes(ctx, change, pr) };
}

/** How many entries of each list a shown fact keeps, and how long each entry may be. */
interface Detail {
  readonly listed: number;
  readonly lineMax: number;
}

function shownFacts(facts: Facts, detail: Detail, notes: JsonObject): JsonObject {
  const list = (values: readonly string[]) =>
    values.slice(0, detail.listed).map((value) => clip(value, detail.lineMax));

  return {
    ...facts,
    manifests: [...facts.manifests],
    usage: { ...facts.usage, files: list(facts.usage.files), markers: list(facts.usage.markers) },
    notes,
    types: {
      ...facts.types,
      added: list(facts.types.added),
      removed: list(facts.types.removed),
      deprecated: list(facts.types.deprecated),
    },
  };
}

/** The facts as a file or an issue body shows them, its size bounded: no notes' text, lists and lines cut. */
export function publicFacts(facts: Facts): JsonObject {
  return shownFacts(
    facts,
    { listed: 20, lineMax: 160 },
    { source: facts.notes.source, compare: facts.notes.compare },
  );
}

/**
 * How many characters of facts the gate prints. A session shows a tool's output inline up to some 30,000 characters
 * and past that hands the model a file, which the leads guard keeps it from opening.
 */
export const FACTS_BUDGET = 20_000;

const NOTES_MIN = 200;

const SHORTEST: Detail = { listed: 2, lineMax: 80 };

/** From the fullest to the shortest. */
const DETAIL: readonly Detail[] = [
  { listed: 10, lineMax: 120 },
  { listed: 4, lineMax: 100 },
  SHORTEST,
];

function printedFacts(facts: Facts, detail: Detail, notes: string): JsonObject {
  return shownFacts(facts, detail, { ...facts.notes, text: notes });
}

/** The candidates as the gate prints them for the model: within `budget` characters, the notes' text cut evenly. */
export function factsForModel(candidates: readonly Facts[], budget: number): JsonObject[] {
  const room = (detail: Detail) =>
    budget - JSON.stringify(candidates.map((facts) => printedFacts(facts, detail, ""))).length;

  const detail = DETAIL.find((level) => room(level) >= candidates.length * NOTES_MIN) ?? SHORTEST;

  const share = Math.floor(room(detail) / Math.max(1, candidates.length));
  const notesMax = Math.min(NOTES_MAX, Math.max(NOTES_MIN, share));

  return candidates.map((facts) => printedFacts(facts, detail, clip(facts.notes.text, notesMax)));
}

export type SkipReason = "no npm manifest change" | "pin" | "no code site" | "patch with no notes";

/** Why an update needs no model, from its size and sites alone: the notes are read only past this. */
export function skipBeforeNotes(
  facts: Pick<SitedFacts, "updateType" | "usage">,
): SkipReason | null {
  if (facts.updateType === "pin") return "pin";

  return facts.usage.codeSites === 0 ? "no code site" : null;
}

/** Why an update needs no model at all, or null when one must judge it. */
export function deterministicSkip(
  facts: Pick<BaseFacts, "updateType" | "usage" | "notes">,
): SkipReason | null {
  if (facts.updateType === "patch" && facts.notes.source === "none") {
    return skipBeforeNotes(facts) ?? "patch with no notes";
  }

  return skipBeforeNotes(facts);
}

// ---------------------------------------------------------------------------
// Issues, comments, the ledger, markers and labels
// ---------------------------------------------------------------------------

export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly open: boolean;
  readonly labels: readonly string[];
  /** Whether its author can push: its text is then the pipeline's own record. */
  readonly trusted: boolean;
  readonly createdAt: string;
  readonly url: string;
}

/** An issue as the REST API returns it; null for a pull request, which the issues endpoints list too. */
export function issueOf(item: Json): Issue | null {
  if (!isRecord(item) || item["pull_request"] !== undefined || !Number.isInteger(item["number"]))
    return null;

  const labels = item["labels"];

  return {
    number: Number(item["number"]),
    title: stringField(item, "title") ?? "",
    body: stringField(item, "body") ?? "",
    open: stringField(item, "state") === "open",
    labels: Array.isArray(labels)
      ? labels.flatMap((label) => (isRecord(label) ? [stringField(label, "name") ?? ""] : []))
      : [],
    trusted: TRUSTED.has(stringField(item, "author_association") ?? ""),
    createdAt: stringField(item, "created_at") ?? "",
    url: stringField(item, "html_url") ?? "",
  };
}

export function issuesWith(ctx: Context, label: string, state: "open" | "all"): Issue[] {
  return ctx.gh
    .list(
      `repos/${ctx.repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc&per_page=100`,
    )
    .flatMap((item) => issueOf(item) ?? []);
}

export function issueNumberOf(created: Json): number {
  const number = isRecord(created) ? created["number"] : undefined;

  if (!Number.isInteger(number))
    throw new Error(`GitHub answered no issue number: ${JSON.stringify(created)}`);

  return Number(number);
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly trusted: boolean;
  /** Milliseconds since the epoch; NaN when GitHub gave no date. */
  readonly createdAt: number;
}

export function commentsOf(items: readonly Json[]): Comment[] {
  return items.flatMap((item) =>
    isRecord(item)
      ? [
          {
            id: Number(item["id"]),
            body: stringField(item, "body") ?? "",
            trusted: TRUSTED.has(stringField(item, "author_association") ?? ""),
            createdAt: Date.parse(stringField(item, "created_at") ?? ""),
          },
        ]
      : [],
  );
}

export function commentsOn(ctx: Context, issue: number): Comment[] {
  return commentsOf(ctx.gh.list(`repos/${ctx.repo}/issues/${issue}/comments?per_page=100`));
}

export function comment(ctx: Context, issue: number, body: string): void {
  ctx.gh.call("POST", `repos/${ctx.repo}/issues/${issue}/comments`, { body });
}

export function addLabel(ctx: Context, issue: number, label: string): void {
  ctx.gh.call("POST", `repos/${ctx.repo}/issues/${issue}/labels`, { labels: [label] });
}

export function removeLabel(ctx: Context, issue: number, label: string): void {
  try {
    ctx.gh.call("DELETE", `repos/${ctx.repo}/issues/${issue}/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    if (!/HTTP 404|Label does not exist/u.test(messageOf(error))) throw error;
  }
}

/** When `label` was last put on the issue, from its events; null when no event says. */
export function labelledAt(ctx: Context, issue: number, label: string): number | null {
  const times = ctx.gh
    .list(`repos/${ctx.repo}/issues/${issue}/events?per_page=100`)
    .flatMap((event) => {
      if (!isRecord(event) || stringField(event, "event") !== "labeled") return [];

      const named = event["label"];

      return isRecord(named) && stringField(named, "name") === label
        ? [Date.parse(stringField(event, "created_at") ?? "")]
        : [];
    });

  const valid = times.filter((time) => Number.isFinite(time));

  return valid.length === 0 ? null : Math.max(...valid);
}

export type Verdict = "skip" | "scan-minor" | "scan-major" | "unsure";

export const VERDICTS: readonly Verdict[] = ["skip", "scan-minor", "scan-major", "unsure"];

export type Tier = "minor" | "major";

export const TIERS: readonly Tier[] = ["minor", "major"];

export const LABEL = {
  ledger: "lead:ledger",
  unsure: "lead:unsure",
  inProgress: "lead:in-progress",
  lead: "lead",
  needsHuman: "needs-human",
} as const;

export function scanLabel(tier: Tier): string {
  return `lead:scan-${tier}`;
}

interface LabelSpec {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

const LABELS: readonly LabelSpec[] = [
  {
    name: LABEL.ledger,
    color: "BFD4F2",
    description: "The leads gate's record of the dependency updates it decided",
  },
  {
    name: scanLabel("minor"),
    color: "C2E0C6",
    description: "A dependency update a Sonnet leads scan reads",
  },
  {
    name: scanLabel("major"),
    color: "0E8A16",
    description: "A dependency update an Opus leads scan reads",
  },
  {
    name: LABEL.unsure,
    color: "FBCA04",
    description: "The leads pipeline could not decide this update",
  },
  { name: LABEL.inProgress, color: "D4C5F9", description: "A leads scan holds this issue" },
  {
    name: LABEL.lead,
    color: "1D76DB",
    description: "Something a dependency update lets this repository adopt or drop",
  },
  { name: LABEL.needsHuman, color: "B60205", description: "Waits for the human" },
];

/** Creates each of the pipeline's labels the repository lacks; one created meanwhile counts as there. */
export function ensureLabels(ctx: Context): void {
  const present = new Set(
    ctx.gh
      .list(`repos/${ctx.repo}/labels?per_page=100`)
      .flatMap((item) => (isRecord(item) ? [stringField(item, "name") ?? ""] : [])),
  );

  for (const spec of LABELS) {
    if (present.has(spec.name)) continue;

    try {
      ctx.gh.call("POST", `repos/${ctx.repo}/labels`, {
        name: spec.name,
        color: spec.color,
        description: spec.description,
      });
    } catch (error) {
      if (!messageOf(error).includes("already_exists")) throw error;
    }
  }
}

export interface LedgerEntry {
  readonly sha7: string;
  /** Null for a commit that changed no npm manifest. */
  readonly package: string | null;
  readonly from: string;
  readonly to: string;
  readonly verdict: Verdict;
  readonly reason: string;
}

export function ledgerKey(sha: string, pkg: string | null): string {
  return `${sha.slice(0, 7)} ${pkg ?? "(none)"}`;
}

export function formatLedger(entry: LedgerEntry): string {
  const what = entry.package === null ? "(none)" : `${entry.package}@${entry.from}→${entry.to}`;

  return `${entry.sha7} ${what} ${entry.verdict} — ${oneLine(entry.reason)}`;
}

// The package is the name before the first `@` past its scope; a version may hold `@` (`npm:x@1.0.0`) or a space.
const LEDGER_LINE =
  /^([0-9a-f]{7}) (?:\(none\)|(\S+?)@(.*?)→(.*?)) (skip|scan-minor|scan-major|unsure) — (.+)$/u;

/** The ledger's entries, from the comments of authors who can push; a line of another shape is no entry. */
export function parseLedger(comments: readonly Comment[]): LedgerEntry[] {
  return comments
    .filter((entry) => entry.trusted)
    .flatMap((entry) => entry.body.split("\n"))
    .flatMap((line) => {
      const match = LEDGER_LINE.exec(line.trim());
      const verdict = VERDICTS.find((known) => known === match?.[5]);

      if (match === null || verdict === undefined) return [];

      return [
        {
          sha7: match[1] ?? "",
          package: match[2] ?? null,
          from: match[3] ?? "",
          to: match[4] ?? "",
          verdict,
          reason: match[6] ?? "",
        },
      ];
    });
}

/**
 * The marker the ledger issue's body carries: the oldest commit date the gate reads, fixed when the ledger is
 * created. Every run reads from there, the ledger telling the updates decided from those left, so an update a run
 * deferred or the model left undecided is read again however long it waits.
 */
export function ledgerStartMarker(since: string): string {
  return `<!-- leads-ledger: since=${since} -->`;
}

const LEDGER_START = /<!-- leads-ledger: since=(\S+) -->/u;

export function parseLedgerStart(body: string): string | null {
  return LEDGER_START.exec(body)?.[1] ?? null;
}

/** At most this many scan tasks start in 24 hours, re-fires included, whatever the model asks. */
export const DAILY_FIRES = 10;

export const DAY_MS = 86_400_000;

export interface Fire {
  readonly issue: number;
  readonly tier: Tier;
  readonly at: number;
}

/** The ledger comment that records a scan task started on an issue, which the budget and the re-fire read back. */
export function fireLine(issue: number, tier: Tier): string {
  return `fired issue ${issue} ${tier}`;
}

const FIRE_LINE = /^fired issue (\d+) (minor|major)$/u;

export function parseFires(comments: readonly Comment[]): Fire[] {
  return comments.flatMap((entry) => {
    const match = entry.trusted ? FIRE_LINE.exec(entry.body.trim()) : null;
    const tier = TIERS.find((known) => known === match?.[2]);

    return match === null || tier === undefined || !Number.isFinite(entry.createdAt)
      ? []
      : [{ issue: Number(match[1]), tier, at: entry.createdAt }];
  });
}

/** When a scan task was last started on `issue`; null when the ledger records none. */
export function lastFire(fires: readonly Fire[], issue: number): number | null {
  const times = fires.flatMap((fire) => (fire.issue === issue ? [fire.at] : []));

  return times.length === 0 ? null : Math.max(...times);
}

export interface ScanRef {
  readonly sha: string;
  readonly package: string;
}

export function scanMarker(sha: string, pkg: string): string {
  return `<!-- leads-scan: sha=${sha} pkg=${pkg} -->`;
}

const SCAN_MARKER = /<!-- leads-scan: sha=([0-9a-f]{40}) pkg=(\S+) -->/u;

export function parseScanMarker(body: string): ScanRef | null {
  const match = SCAN_MARKER.exec(body);

  return match === null ? null : { sha: match[1] ?? "", package: match[2] ?? "" };
}

/** A lead's key as its marker holds it: lower case, dashes between words, at most 60 characters. */
export function normKey(key: string): string {
  return key
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .slice(0, 60)
    .replaceAll(/^-+|-+$/gu, "");
}

export function leadMarker(pkg: string, key: string): string {
  return `<!-- lead: pkg=${pkg} key=${normKey(key)} -->`;
}

const LEAD_MARKER = /<!-- lead: pkg=(\S+) key=([a-z0-9-]+) -->/u;

export interface LeadRef {
  readonly package: string;
  readonly key: string;
}

export function parseLeadMarker(body: string): LeadRef | null {
  const match = LEAD_MARKER.exec(body);

  return match === null ? null : { package: match[1] ?? "", key: match[2] ?? "" };
}

export interface ExistingLead {
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly open: boolean;
}

/** The leads already filed for `pkg`, open or closed: a closed one was refused and is never filed again. */
export function existingLeads(issues: readonly Issue[], pkg: string): ExistingLead[] {
  return issues.flatMap((issue) => {
    const ref = issue.trusted ? parseLeadMarker(issue.body) : null;

    return ref?.package === pkg
      ? [{ number: issue.number, key: ref.key, title: issue.title, open: issue.open }]
      : [];
  });
}

// ---------------------------------------------------------------------------
// Text that reaches a public issue
// ---------------------------------------------------------------------------

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x20_0b);

/** Control and format characters: a bidi override reorders what the reader sees, a zero-width one hides a break. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** The `[` of a `[label]:`, which opens a link reference definition: GitHub renders it as nothing. */
const LINK_DEFINITION = /\[(?=[^\]\n]*\]:)/gu;

// GitHub reads a mention after any character but a name's: `.@x`, `+@x` and `-@x` mention, `zustand@5.0.16` does not.
// `](` opens a link whose target may have no scheme (`//host`), which no URL rule would catch.
const NEUTRALIZE =
  /(https?:\/\/[^\s<>`"')\]]+|\bwww\.[^\s<>`"')\]]+)|(?<![A-Za-z0-9_])@(?=[A-Za-z0-9])|#(?=\d)|\bGH-(?=\d)|\]\(/giu;

/**
 * Text a model or an upstream wrote, made safe to publish under the user's name: no HTML comment (a forged marker),
 * no control, format or bidi character, no tag, entity or link reference definition, no `@mention`, `#123`,
 * `owner/repo#123` or `GH-123` GitHub would link and notify, no link, and every URL `allowUrl` refuses in inline code.
 */
export function sanitizeIssueText(
  text: string,
  allowUrl: (url: string) => boolean = () => false,
): string {
  return text
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replaceAll(INVISIBLE, (char) => (char === "\n" || char === "\t" ? char : ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(LINK_DEFINITION, "\\[")
    .replaceAll(NEUTRALIZE, (match, url: string | undefined) => {
      if (url !== undefined) return allowUrl(url) ? url : `\`${url.replaceAll("`", "")}\``;

      return match === "](" ? "]\\(" : `${match}${ZERO_WIDTH_SPACE}`;
    });
}

/** Text in a fenced block that no backtick run in it can close: GitHub renders none of it as Markdown. */
export function textBlock(text: string): string {
  const longest = Math.max(3, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length + 1));
  const fence = "`".repeat(longest);

  return `${fence}text\n${text}\n${fence}`;
}

/** `char` as JSON's `\uXXXX` escapes, one per UTF-16 unit. */
function jsonEscape(char: string): string {
  return Array.from(
    { length: char.length },
    // oxlint-disable-next-line unicorn/prefer-code-point -- JSON's \u escape takes UTF-16 units, which charCodeAt returns.
    (_, index) => `\\u${char.charCodeAt(index).toString(16).padStart(4, "0")}`,
  ).join("");
}

/**
 * A JSON value in a fenced block that no backtick run in it can close, no `<` in it can open a marker, and no control,
 * format or bidi character in it can hide or reorder what renders.
 */
export function jsonBlock(value: Json): string {
  const text = JSON.stringify(value, null, 2)
    .replaceAll("<", "\\u003c")
    .replaceAll(INVISIBLE, (char) => (char === "\n" ? char : jsonEscape(char)));

  const longest = Math.max(3, ...[...text.matchAll(/`+/gu)].map((run) => run[0].length + 1));
  const fence = "`".repeat(longest);

  return `${fence}json\n${text}\n${fence}`;
}

// ---------------------------------------------------------------------------
// Starting a scan task
// ---------------------------------------------------------------------------

export type Fired =
  | { readonly kind: "fired"; readonly session: string }
  | { readonly kind: "unset" }
  | { readonly kind: "failed"; readonly status: string };

function fireVariables(
  env: Env,
  tier: Tier,
): { readonly url: string; readonly token: string } | null {
  const suffix = tier.toUpperCase();
  const url = env[`LEADS_FIRE_URL_${suffix}`] ?? "";
  const token = env[`LEADS_FIRE_TOKEN_${suffix}`] ?? "";

  return url === "" || token === "" ? null : { url, token };
}

export function canFire(env: Env, tier: Tier): boolean {
  return fireVariables(env, tier) !== null;
}

/** The secrets a published text must never hold: the fire tokens the environment carries. */
export function secretsOf(env: Env): readonly string[] {
  return TIERS.flatMap((tier) => fireVariables(env, tier)?.token ?? []);
}

/** Starts the scan task of `tier` on `issue` through its `/fire` endpoint; the token is never printed. */
export async function fireScan(ctx: Context, tier: Tier, issue: number): Promise<Fired> {
  const variables = fireVariables(ctx.env, tier);

  if (variables === null) return { kind: "unset" };

  if (isDryRun(ctx.env)) {
    ctx.print(`dry run: fire the ${tier} scan task on #${issue}`);

    return { kind: "fired", session: "(dry run)" };
  }

  try {
    const response = await ctx.fetch(variables.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${variables.token}`,
        "anthropic-version": "2026-10-21",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: String(issue) }),
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });

    if (!response.ok) return { kind: "failed", status: `HTTP ${response.status}` };

    const answer = parseJson(await response.text());
    const session = isRecord(answer) ? stringField(answer, "claude_code_session_url") : undefined;

    return session === undefined
      ? { kind: "failed", status: "HTTP 200 without claude_code_session_url" }
      : { kind: "fired", session };
  } catch (error) {
    return { kind: "failed", status: messageOf(error).replaceAll(variables.token, "<token>") };
  }
}

/** Whether a scan may take `issue` now: no live `lead:in-progress`, one older than the claim's TTL counting as none. */
export function claimFree(ctx: Context, issue: Issue, now: number): boolean {
  if (!issue.labels.includes(LABEL.inProgress)) return true;

  const since = labelledAt(ctx, issue.number, LABEL.inProgress);

  return since === null || now - since > CLAIM_TTL_MS;
}

/** An open scan issue of `tier` the pipeline wrote, which nobody gave up on. */
export function isScannable(issue: Issue, tier: Tier): boolean {
  return (
    issue.open &&
    issue.trusted &&
    issue.labels.includes(scanLabel(tier)) &&
    !issue.labels.includes(LABEL.unsure) &&
    parseScanMarker(issue.body) !== null
  );
}
