import path from "node:path";

import type { LandingProfile } from "./config.ts";

/** A git invocation: the global options that locate its repository, in order, then its subcommand. */
export type GitCommand = {
  readonly location: readonly string[];
  readonly subcommand: string;
  readonly args: readonly string[];
};

/** A target that names every branch: `--all`, `--mirror`, or a refspec with a `*`. */
export const EVERY_BRANCH = "*";

/** A target that names the branch checked out where the push runs: no refspec, or `HEAD` alone. */
export const CURRENT_BRANCH = "HEAD";

export type PushTarget = {
  readonly ref: string;
  readonly forced: boolean;
  readonly deleted: boolean;
};

export type Push = { readonly remote: string | null; readonly targets: readonly PushTarget[] };

export type GhCommand =
  | { readonly kind: "pr-merge"; readonly selector: string | null; readonly repo: string | null }
  | { readonly kind: "release-create"; readonly repo: string | null };

export type ReleaseScript = { readonly script: string; readonly dryRun: boolean };

export type RepoFacts = { readonly visibility: string; readonly defaultBranch: string };

export type Check = { readonly name: string; readonly state: string; readonly startedAt: string };

export type PullRequestFacts = {
  readonly number: number;
  readonly url: string;
  readonly baseRefName: string;
  readonly mergeable: string;
  readonly checks: readonly Check[];
};

const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);

const GIT_LOCATING_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);

const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec"]);

const FORCE_OPTION = /^--force(?:-with-lease(?:=.*)?|-if-includes)?$/u;

const SHORT_OPTIONS = /^-[A-Za-z0-9]+$/u;

const GH_MERGE_VALUE_OPTIONS = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "--match-head-commit",
  "-A",
  "--author-email",
]);

const RUNNERS = new Set(["bun", "node", "deno", "tsx", "bash", "sh", "zsh"]);

const RELEASE_SCRIPT = /\/scripts\/release\.[A-Za-z]+$/u;

const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

const LAND = "bun ./scripts/land.ts <branch>";

function splitOption(word: string): readonly [string, string | undefined] {
  const equals = word.indexOf("=");

  return equals === -1 ? [word, undefined] : [word.slice(0, equals), word.slice(equals + 1)];
}

/** The git invocation `argv` runs, its global options read as git reads them; null for any other program. */
export function gitCommandOf(argv: readonly string[]): GitCommand | null {
  const [program, ...rest] = argv;

  if (program === undefined || path.basename(program) !== "git") {
    return null;
  }

  const location: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";

    if (!word.startsWith("-")) {
      return { location, subcommand: word, args: rest.slice(index + 1) };
    }

    const [name, attached] = splitOption(word);

    if (attached === undefined && GIT_VALUE_OPTIONS.has(name)) {
      index += 1;
      const value = rest[index];

      if (value !== undefined && GIT_LOCATING_OPTIONS.has(name)) {
        location.push(name, value);
      }
    } else if (attached !== undefined && GIT_LOCATING_OPTIONS.has(name)) {
      location.push(name, attached);
    }
  }

  return null;
}

/** What a `git push` with these arguments updates; null for a dry run, which updates nothing. */
export function pushOf(args: readonly string[]): Push | null {
  let force = false;
  let deletes = false;
  let dryRun = false;
  let every = false;
  let mirror = false;
  let tagsOnly = false;
  let repoOption: string | null = null;
  let options = true;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    const [name, attached] = splitOption(word);

    if (!options || !word.startsWith("-") || word === "-") {
      positionals.push(word);
    } else if (word === "--") {
      options = false;
    } else if (FORCE_OPTION.test(word)) {
      force = true;
    } else if (name === "--delete") {
      deletes = true;
    } else if (name === "--dry-run") {
      dryRun = true;
    } else if (name === "--all" || name === "--branches") {
      every = true;
    } else if (name === "--mirror") {
      mirror = true;
    } else if (name === "--tags") {
      tagsOnly = true;
    } else if (name === "--repo") {
      repoOption = attached ?? args[index + 1] ?? null;
      index += attached === undefined ? 1 : 0;
    } else if (attached === undefined && PUSH_VALUE_OPTIONS.has(name)) {
      index += 1;
    } else if (SHORT_OPTIONS.test(word)) {
      const letters = word.slice(1);
      force ||= letters.includes("f");
      deletes ||= letters.includes("d");
      dryRun ||= letters.includes("n");
      index += letters.endsWith("o") ? 1 : 0;
    }
  }

  if (dryRun) {
    return null;
  }

  const [remote = repoOption, ...refspecs] = positionals;

  if (mirror) {
    return { remote, targets: [{ ref: EVERY_BRANCH, forced: true, deleted: true }] };
  }

  const targets = targetsOf(refspecs, force, deletes);

  if (every) {
    targets.push({ ref: EVERY_BRANCH, forced: force, deleted: false });
  } else if (refspecs.length === 0 && !tagsOnly) {
    targets.push({ ref: CURRENT_BRANCH, forced: force, deleted: deletes });
  }

  return { remote, targets };
}

function targetsOf(refspecs: readonly string[], force: boolean, deletes: boolean): PushTarget[] {
  const targets: PushTarget[] = [];

  for (let index = 0; index < refspecs.length; index += 1) {
    const refspec = refspecs[index] ?? "";

    if (refspec === "tag") {
      index += 1;
      continue;
    }

    const plus = refspec.startsWith("+");
    const body = plus ? refspec.slice(1) : refspec;
    const colon = body.indexOf(":");
    const source = colon === -1 ? body : body.slice(0, colon);
    const destination = colon === -1 ? body : body.slice(colon + 1);
    const ref = branchOf(destination);

    if (ref !== null) {
      targets.push({
        ref: colon === -1 && (source === "HEAD" || source === "@") ? CURRENT_BRANCH : ref,
        forced: force || plus,
        deleted: deletes || (colon !== -1 && source === ""),
      });
    }
  }

  return targets;
}

/** The branch a refspec destination names, `*` for a pattern; null for a tag, a note or any other ref. */
function branchOf(destination: string): string | null {
  const name = destination.startsWith("refs/heads/")
    ? destination.slice("refs/heads/".length)
    : destination;

  if (name === "" || name.startsWith("refs/")) {
    return null;
  }

  return name.includes("*") ? EVERY_BRANCH : name;
}

/** The `gh` subcommand of a one-way door: `gh pr merge` and `gh release create`; null for any other. */
export function ghCommandOf(argv: readonly string[]): GhCommand | null {
  const [program, group, action, ...rest] = argv;

  if (program === undefined || path.basename(program) !== "gh") {
    return null;
  }

  let repo: string | null = null;
  let disablesAuto = false;
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const [name, attached] = splitOption(word);

    if (name === "-R" || name === "--repo") {
      repo = attached ?? rest[index + 1] ?? null;
      index += attached === undefined ? 1 : 0;
    } else if (name === "--disable-auto") {
      disablesAuto = true;
    } else if (attached === undefined && GH_MERGE_VALUE_OPTIONS.has(name)) {
      index += 1;
    } else if (!word.startsWith("-")) {
      positionals.push(word);
    }
  }

  if (group === "pr" && action === "merge" && !disablesAuto) {
    return { kind: "pr-merge", selector: positionals[0] ?? null, repo };
  }

  return group === "release" && action === "create" ? { kind: "release-create", repo } : null;
}

/** A run of a repository's `scripts/release.<ext>` from `cwd`, directly or through a runtime such as `bun`. */
export function releaseScriptOf(argv: readonly string[], cwd: string): ReleaseScript | null {
  const [program, ...rest] = argv;

  if (program === undefined) {
    return null;
  }

  const words = RUNNERS.has(path.basename(program))
    ? rest.filter((word) => !word.startsWith("-"))
    : [program];

  const script = words[0] === "run" ? words[1] : words[0];

  if (script === undefined || !RELEASE_SCRIPT.test(path.resolve(cwd, script))) {
    return null;
  }

  return { script, dryRun: argv.slice(argv.indexOf(script) + 1).includes("--dry-run") };
}

/** The targets with the current branch put in for `HEAD`; a `HEAD` target is dropped when no branch is checked out. */
export function resolveTargets(
  targets: readonly PushTarget[],
  currentBranch: string | null,
): PushTarget[] {
  return targets.flatMap((target) => {
    if (target.ref !== CURRENT_BRANCH) {
      return [target];
    }

    return currentBranch === null ? [] : [{ ...target, ref: currentBranch }];
  });
}

function reaches(target: PushTarget, branch: string): boolean {
  return target.ref === EVERY_BRANCH || target.ref === branch;
}

function landInstead(landScript: boolean): string {
  return landScript
    ? `land with ${LAND} once its pull request is green`
    : "push a feature branch and open a pull request";
}

/** Why a push in a repository with a landing profile is refused; null when it may run. */
export function profiledPushRefusal(
  targets: readonly PushTarget[],
  landing: LandingProfile,
  landScript: boolean,
): string | null {
  const { trunk, release } = landing;

  if (targets.some((target) => reaches(target, release))) {
    return (
      `agent-hooks: a push to '${release}' moves the release, and the release is the human's. ` +
      `Commit on '${trunk}' and push it there, or ${landInstead(landScript)}.`
    );
  }

  if (targets.some((target) => reaches(target, trunk) && (target.forced || target.deleted))) {
    return (
      `agent-hooks: a force push or a deletion never targets '${trunk}': every clone caches it. ` +
      `Rebase on origin/${trunk} and push without force, or ${landInstead(landScript)}.`
    );
  }

  return null;
}

/** Why a push to a repository without a landing profile is refused: its target is the default branch of a public repository. */
export function publicPushRefusal(
  targets: readonly PushTarget[],
  repo: RepoFacts,
  slug: string,
): string | null {
  if (
    repo.visibility !== "PUBLIC" ||
    !targets.some((target) => reaches(target, repo.defaultBranch))
  ) {
    return null;
  }

  return (
    `agent-hooks: '${repo.defaultBranch}' is the default branch of the public repository ${slug}, ` +
    "and moving it is the human's. Push a feature branch and open a pull request instead. " +
    "A repository whose agents land on their own declares profile.landing in .claude/agent-hooks.jsonc."
  );
}

/** The newest check of each name: a re-run supersedes the attempt before it, as in `gh pr checks`. */
export function latestChecks(checks: readonly Check[]): Check[] {
  const newest = new Map<string, Check>();

  for (const check of checks) {
    const kept = newest.get(check.name);

    if (kept === undefined || check.startedAt > kept.startedAt) {
      newest.set(check.name, check);
    }
  }

  return [...newest.values()];
}

/** Why `gh pr merge` on `pr` is refused in a repository with a landing profile; null when it may run. */
export function profiledMergeRefusal(
  pr: PullRequestFacts,
  landing: LandingProfile,
  landScript: boolean,
): string | null {
  const name = `#${pr.number}`;
  const checks = latestChecks(pr.checks);
  const running = checks.filter((check) => PENDING.has(check.state));
  const red = checks.filter((check) => !GREEN.has(check.state) && !PENDING.has(check.state));

  if (pr.baseRefName === landing.release) {
    return (
      `agent-hooks: ${name} merges into '${landing.release}', the release, and the release is the human's. ` +
      `Retarget it (gh pr edit ${pr.number} --base ${landing.trunk}), then ${landInstead(landScript)}.`
    );
  }

  if (checks.length === 0) {
    return `agent-hooks: no check reported on ${name}'s head yet: wait for its run (gh pr checks ${pr.number} --watch), then merge.`;
  }

  if (red.length > 0 || running.length > 0) {
    const states = [...red, ...running].map(
      (check) => `${check.name} ${check.state.toLowerCase()}`,
    );

    return (
      `agent-hooks: checks not green on ${name}: ${states.join(", ")}. ` +
      `Wait for the running ones (gh pr checks ${pr.number} --watch) and fix the red ones before merging.`
    );
  }

  if (pr.mergeable !== "MERGEABLE") {
    return (
      `agent-hooks: ${name} is not mergeable (${pr.mergeable.toLowerCase()}): ` +
      `rebase its branch on origin/${pr.baseRefName} and push it, or retry once GitHub has computed it.`
    );
  }

  return null;
}

/** Why `gh pr merge` on `pr` is refused in a repository without a landing profile: it merges into the default branch of a public repository. */
export function publicMergeRefusal(
  pr: PullRequestFacts,
  repo: RepoFacts,
  slug: string,
): string | null {
  if (repo.visibility !== "PUBLIC" || pr.baseRefName !== repo.defaultBranch) {
    return null;
  }

  return (
    `agent-hooks: #${pr.number} merges into '${repo.defaultBranch}', the default branch of the public repository ${slug}, ` +
    "and moving it is the human's. Leave the merge to the human."
  );
}

/** Why a door is refused in a repository whose profile cannot be read: the doors it would guard are unknown. */
export function unreadableProfileRefusal(error: string, command: string): string {
  return `${error}. The landing guard cannot read this repository's profile.landing, so it refuses ${command} until the file is fixed.`;
}

/** Why a release command is refused in a repository with a landing profile. */
export function releaseRefusal(command: string, landing: LandingProfile): string {
  return (
    `agent-hooks: ${command} publishes '${landing.release}', and the release is the human's. ` +
    "Say the release is ready and leave it to the human."
  );
}
