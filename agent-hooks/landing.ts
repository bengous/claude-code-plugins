import path from "node:path";

import type { LandingProfile } from "./config.ts";

/** A git invocation: the global options that locate its repository, in order, then its subcommand. */
export type GitCommand = {
  readonly location: readonly string[];
  /** The aliases its `-c alias.<name>=…` options define. */
  readonly inlineAliases: readonly string[];
  readonly subcommand: string;
  /** Where the subcommand stands in argv. */
  readonly index: number;
  readonly args: readonly string[];
};

/** A target that names every branch: `--all`, `--mirror`, or a refspec with a `*`. */
export const EVERY_BRANCH = "*";

/** A target that names the branch checked out where the push runs: `HEAD` or `@` alone. */
export const CURRENT_BRANCH = "HEAD";

/** A target a push without refspec updates: where `@{push}` points, per push.default and remote.<r>.push. */
export const PUSH_DESTINATION = "@{push}";

/** The branches a push without an explicit destination can reach, read from git where it runs. */
export type Branches = {
  readonly current: string | null;
  /** The remote branch `@{push}` names; null when git cannot resolve it. */
  readonly push: string | null;
};

export type PushTarget = {
  readonly ref: string;
  readonly forced: boolean;
  readonly deleted: boolean;
};

export type Push = { readonly remote: string | null; readonly targets: readonly PushTarget[] };

/** A `gh` invocation: its subcommand group and action, its positionals after them, and `--repo` wherever it stands. */
export type GhCommand = {
  readonly group: string | null;
  readonly action: string | null;
  readonly positionals: readonly string[];
  readonly repo: string | null;
  readonly flags: ReadonlySet<string>;
};

/** A run of a release script: the word that names it, its absolute path, and whether it is a dry run. */
export type ReleaseScript = {
  readonly script: string;
  readonly path: string;
  readonly dryRun: boolean;
};

/** A run of a `package.json` script: its name, the directory the package manager starts from, its extra arguments. */
export type PackageScript = {
  readonly name: string;
  readonly cwd: string;
  readonly args: readonly string[];
};

export type RepoFacts = { readonly visibility: string; readonly defaultBranch: string };

/** One check as `gh pr checks --json` prints it: a commit status has no workflow and no event. */
export type Check = {
  readonly name: string;
  readonly state: string;
  readonly startedAt: string;
  readonly workflow: string;
  readonly event: string;
};

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

/** How a runtime or a package manager names what it runs, read from its own options and subcommands. */
type Runner = {
  /** Options that take a value, as the next word or attached (`--cwd=x`). */
  readonly values: ReadonlySet<string>;
  readonly chdir: ReadonlySet<string>;
  /** Options with which it runs no script: a syntax check, an inline program. */
  readonly runsNothing: ReadonlySet<string>;
  /** Subcommands whose next positional is what it runs. */
  readonly run: ReadonlySet<string>;
  /** Subcommands that run no script of the repository. */
  readonly ignored: ReadonlySet<string>;
  readonly files: boolean;
  readonly packageScripts: boolean;
};

const NODE_LIKE: Runner = {
  values: new Set([
    "-r",
    "--require",
    "--import",
    "--loader",
    "--experimental-loader",
    "--env-file",
    "--input-type",
    "-C",
    "--conditions",
    "--title",
  ]),
  chdir: new Set(),
  runsNothing: new Set(["-c", "--check", "-e", "--eval", "-p", "--print"]),
  run: new Set(["watch"]),
  ignored: new Set(),
  files: true,
  packageScripts: false,
};

const SHELL_RUNNER: Runner = {
  values: new Set(["-o", "-O", "+O", "--rcfile", "--init-file"]),
  chdir: new Set(),
  runsNothing: new Set(["-n"]),
  run: new Set(),
  ignored: new Set(),
  files: true,
  packageScripts: false,
};

const RUNNERS: ReadonlyMap<string, Runner> = new Map<string, Runner>([
  [
    "bun",
    {
      values: new Set([
        "--cwd",
        "-c",
        "--config",
        "--env-file",
        "-r",
        "--preload",
        "--tsconfig-override",
        "-d",
        "--define",
        "-l",
        "--loader",
        "--port",
        "--main-fields",
        "--conditions",
        "-F",
        "--filter",
        "--elide-lines",
        "--shell",
      ]),
      chdir: new Set(["--cwd"]),
      runsNothing: new Set(["-e", "--eval", "-p", "--print"]),
      run: new Set(["run"]),
      ignored: new Set([
        "build",
        "test",
        "install",
        "i",
        "add",
        "a",
        "remove",
        "rm",
        "update",
        "outdated",
        "link",
        "unlink",
        "pm",
        "init",
        "create",
        "upgrade",
        "publish",
        "patch",
        "audit",
        "info",
        "why",
        "x",
      ]),
      files: true,
      packageScripts: true,
    },
  ],
  ["node", NODE_LIKE],
  ["tsx", NODE_LIKE],
  [
    "deno",
    {
      values: new Set(["-c", "--config", "--import-map", "--cert", "--location", "--lock"]),
      chdir: new Set(),
      runsNothing: new Set(),
      run: new Set(["run"]),
      ignored: new Set([
        "check",
        "fmt",
        "lint",
        "compile",
        "test",
        "bench",
        "info",
        "doc",
        "cache",
        "install",
        "bundle",
      ]),
      files: true,
      packageScripts: false,
    },
  ],
  ["bash", SHELL_RUNNER],
  ["sh", SHELL_RUNNER],
  ["zsh", SHELL_RUNNER],
  [
    "npm",
    {
      values: new Set(["--prefix", "-w", "--workspace"]),
      chdir: new Set(["--prefix"]),
      runsNothing: new Set(),
      run: new Set(["run", "run-script", "rum", "urn"]),
      ignored: new Set(),
      files: false,
      packageScripts: true,
    },
  ],
  [
    "pnpm",
    {
      values: new Set(["-C", "--dir", "-F", "--filter"]),
      chdir: new Set(["-C", "--dir"]),
      runsNothing: new Set(),
      run: new Set(["run"]),
      ignored: new Set(),
      files: false,
      packageScripts: true,
    },
  ],
  [
    "yarn",
    {
      values: new Set(["--cwd"]),
      chdir: new Set(["--cwd"]),
      runsNothing: new Set(),
      run: new Set(["run"]),
      ignored: new Set(),
      files: false,
      packageScripts: true,
    },
  ],
]);

const FILE_LIKE = /\/|\.(?:[cm]?[jt]sx?|sh)$/u;

export type ScriptRun =
  | {
      readonly kind: "file";
      readonly script: string;
      readonly path: string;
      readonly args: readonly string[];
    }
  | { readonly kind: "package-script"; readonly script: PackageScript };

const RELEASE_SCRIPT = /\/scripts\/release(?:\.[A-Za-z]+)?$/u;

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
  const inlineAliases: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";

    if (!word.startsWith("-")) {
      return {
        location,
        inlineAliases,
        subcommand: word,
        index: index + 1,
        args: rest.slice(index + 1),
      };
    }

    const [name, attached] = splitOption(word);
    const value = attached ?? (GIT_VALUE_OPTIONS.has(name) ? rest[index + 1] : undefined);
    index += attached === undefined && GIT_VALUE_OPTIONS.has(name) ? 1 : 0;

    if (value !== undefined && GIT_LOCATING_OPTIONS.has(name)) {
      location.push(name, value);
    }

    const alias = name === "-c" ? /^alias\.([^=]+)=/u.exec(value ?? "")?.[1] : undefined;

    if (alias !== undefined) {
      inlineAliases.push(alias);
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
    targets.push({ ref: PUSH_DESTINATION, forced: force, deleted: deletes });
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

/** The `gh` invocation `argv` runs, `-R`/`--repo` read wherever it stands; null for any other program. */
export function ghCommandOf(argv: readonly string[]): GhCommand | null {
  const [program, ...rest] = argv;

  if (program === undefined || path.basename(program) !== "gh") {
    return null;
  }

  let repo: string | null = null;
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const [name, attached] = splitOption(word);

    if (name === "-R" || name === "--repo") {
      repo = attached ?? rest[index + 1] ?? null;
      index += attached === undefined ? 1 : 0;
    } else if (word.startsWith("-R") && word.length > 2) {
      repo = word.slice(2);
    } else if (attached === undefined && GH_MERGE_VALUE_OPTIONS.has(name)) {
      index += 1;
    } else if (word.startsWith("-")) {
      flags.add(name);
    } else {
      positionals.push(word);
    }
  }

  const [group = null, action = null, ...rest2] = positionals;

  return { group, action, positionals: rest2, repo, flags };
}

/** A `gh pr merge` that merges now or once its checks pass; `--disable-auto` merges nothing. */
export function isPrMerge(command: GhCommand): boolean {
  return (
    command.group === "pr" && command.action === "merge" && !command.flags.has("--disable-auto")
  );
}

export function isReleaseCreate(command: GhCommand): boolean {
  return command.group === "release" && command.action === "create";
}

/**
 * What `argv` runs from `cwd`: a file, directly or through a runtime, or a `package.json` script through a package
 * manager (`bun run x`, `npm run x -- args`, `pnpm x`); null for a use that runs nothing (`node --check`, `bun build`).
 */
export function scriptRunOf(argv: readonly string[], cwd: string): ScriptRun | null {
  const [program, ...rest] = argv;
  const runner = program === undefined ? undefined : RUNNERS.get(path.basename(program));

  if (program === undefined || runner === undefined) {
    return program !== undefined && program.includes("/")
      ? { kind: "file", script: program, path: path.resolve(cwd, program), args: rest }
      : null;
  }

  let dir = cwd;
  let index = 0;
  let subcommand: string | null = null;

  for (; index < rest.length; index += 1) {
    const word = rest[index] ?? "";
    const [name, attached] = splitOption(word);

    if (runner.runsNothing.has(name)) {
      return null;
    }

    if (!word.startsWith("-") && subcommand === null && runner.run.has(word)) {
      subcommand = word;
    } else if (!word.startsWith("-")) {
      break;
    } else if (runner.values.has(name)) {
      const value = attached ?? rest[index + 1];
      index += attached === undefined ? 1 : 0;
      dir = value !== undefined && runner.chdir.has(name) ? path.resolve(dir, value) : dir;
    }
  }

  const target = rest[index];
  const after = rest.slice(index + 1);

  if (target === undefined || (subcommand === null && runner.ignored.has(target))) {
    return null;
  }

  if (FILE_LIKE.test(target)) {
    return runner.files
      ? { kind: "file", script: target, path: path.resolve(dir, target), args: after }
      : null;
  }

  const separator = after.indexOf("--");

  const args =
    path.basename(program) === "npm" && separator !== -1 ? after.slice(separator + 1) : after;

  return runner.packageScripts
    ? { kind: "package-script", script: { name: target, cwd: dir, args } }
    : null;
}

/** A run of a repository's `scripts/release.<ext>` from `cwd`, directly or through a runtime such as `bun`. */
export function releaseScriptOf(argv: readonly string[], cwd: string): ReleaseScript | null {
  const run = scriptRunOf(argv, cwd);

  return run?.kind === "file" && RELEASE_SCRIPT.test(run.path)
    ? { script: run.script, path: run.path, dryRun: run.args.includes("--dry-run") }
    : null;
}

/** A run of a `package.json` script, whose commands the guard reads in turn. */
export function packageScriptOf(argv: readonly string[], cwd: string): PackageScript | null {
  const run = scriptRunOf(argv, cwd);

  return run?.kind === "package-script" ? run.script : null;
}

/**
 * The targets with branch names put in: a push without refspec reaches `@{push}`, or the current branch when git
 * cannot resolve it (a push from the release, or a forced one from the trunk, stays refused); `HEAD` reaches the
 * current branch and `@{push}`, since remote.<r>.push can map it elsewhere. No branch checked out leaves no target.
 */
export function resolveTargets(targets: readonly PushTarget[], branches: Branches): PushTarget[] {
  return targets.flatMap((target) => {
    const refs =
      target.ref === PUSH_DESTINATION
        ? [branches.push ?? branches.current]
        : target.ref === CURRENT_BRANCH
          ? [branches.current, branches.push]
          : [target.ref];

    return [...new Set(refs)].flatMap((ref) => (ref === null ? [] : [{ ...target, ref }]));
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

/**
 * The newest run of each check: a re-run supersedes the attempt before it, while a run of the same name from another
 * workflow or another event stays, as `eliminateDuplicates` keys them in gh's `pkg/cmd/pr/checks/aggregate.go`.
 */
export function latestChecks(checks: readonly Check[]): Check[] {
  const newest = new Map<string, Check>();

  for (const check of checks) {
    const key = `${check.name}/${check.workflow}/${check.event}`;
    const kept = newest.get(key);

    if (kept === undefined || check.startedAt > kept.startedAt) {
      newest.set(key, check);
    }
  }

  return [...newest.values()];
}

/**
 * Why `gh pr merge` on `pr` is refused in a repository with a landing profile; null when it may run. With `auto`,
 * GitHub merges once the checks pass, so a check still running, or none reported yet, waits instead of refusing.
 */
export function profiledMergeRefusal(
  pr: PullRequestFacts,
  landing: LandingProfile,
  landScript: boolean,
  auto = false,
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

  if (checks.length === 0 && !auto) {
    return `agent-hooks: no check reported on ${name}'s head yet: wait for its run (gh pr checks ${pr.number} --watch), then merge.`;
  }

  if (red.length > 0 || (running.length > 0 && !auto)) {
    const states = [...red, ...(auto ? [] : running)].map(
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

/** The door a mention of the line names: a push, a merge, a release command, or a package script that opens one. */
export type DoorKind = "push" | "merge" | "release" | "script";

const UNRESOLVED_SUBJECT: Readonly<Record<DoorKind, string>> = {
  push: "a git push",
  merge: "a gh pr merge",
  release: "a release command",
  script: "a package script that opens a door",
};

const EXPLICIT_FORM: Readonly<Record<DoorKind, string>> = {
  push: "Run the push alone, from the repository, with literal names: git push origin <branch>",
  merge:
    "Run it alone, from the repository, with a literal number: gh pr merge <number> (or gh pr merge <number> --repo <owner>/<name>)",
  release:
    "The release is the human's; its plan runs alone, from the repository: bun ./scripts/release.ts --dry-run",
  script: "Run the script's commands themselves, one at a time, with literal names",
};

/** Why a door the guard cannot resolve is refused, with the explicit form that it can. */
export function unresolvedRefusal(kind: DoorKind, why: string): string {
  return `agent-hooks: the guard cannot resolve ${UNRESOLVED_SUBJECT[kind]} in this command: ${why}. ${EXPLICIT_FORM[kind]}.`;
}

/** Whether `name` is a runtime or a package manager the guard reads the options of. */
export function isRunner(name: string): boolean {
  return RUNNERS.has(name);
}

/** Why a release command is refused in a repository with a landing profile. */
export function releaseRefusal(command: string, landing: LandingProfile): string {
  return (
    `agent-hooks: ${command} publishes '${landing.release}', and the release is the human's. ` +
    "Say the release is ready and leave it to the human."
  );
}
