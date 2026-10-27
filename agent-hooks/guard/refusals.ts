import type { Approval, LandingProfile } from "../config.ts";
import type { PushTarget } from "./argv.ts";
import { EVERY_BRANCH } from "./argv.ts";
import type { Check, PullRequestFacts, RepoFacts } from "./github.ts";

const GREEN = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

const PENDING = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

const LAND = "bun ./scripts/land.ts <branch>";

function reaches(target: PushTarget, branch: string): boolean {
  return target.ref === EVERY_BRANCH || target.ref === branch;
}

function landInstead(landScript: boolean): string {
  return landScript
    ? `land with ${LAND} once its pull request is green`
    : "push a feature branch and open a pull request";
}

/** The way to the trunk where the landing action moves it: the task branch's pull request. */
function throughAction(trunk: string): string {
  return `Push your task branch and open a pull request to '${trunk}': the landing action fast-forwards '${trunk}' to its head once its run is green.`;
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
      (landing.by === "action"
        ? throughAction(trunk)
        : `Commit on '${trunk}' and push it there, or ${landInstead(landScript)}.`)
    );
  }

  if (landing.by === "action" && targets.some((target) => reaches(target, trunk))) {
    return `agent-hooks: '${trunk}' moves only through the landing action, never by an agent's push. ${throughAction(trunk)}`;
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
 * Why `gh pr merge` on `pr` is refused in a repository with a landing profile; null when it may run. `--auto` changes
 * nothing: gh merges a pull request GitHub already deems mergeable at once, whatever its checks.
 */
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
      `Retarget it (gh pr edit ${pr.number} --base ${landing.trunk}), then ` +
      (landing.by === "action"
        ? `leave it to the landing action, which fast-forwards '${landing.trunk}' once its run is green.`
        : `${landInstead(landScript)}.`)
    );
  }

  if (landing.by === "action" && pr.baseRefName === landing.trunk) {
    return `agent-hooks: ${name} lands on '${landing.trunk}' through the landing action alone, which fast-forwards '${landing.trunk}' to its head once its run is green: leave the merge to it.`;
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
export function unreadableProfileRefusal(
  error: string,
  command: string,
  key: "landing" | "approvals" = "landing",
): string {
  return `${error}. The landing guard cannot read this repository's profile.${key}, so it refuses ${command} until the file is fixed.`;
}

/** The door a mention of the line names: a push, a merge, a release command, or a package script that opens one. */
export type DoorKind = "push" | "merge" | "release" | "script" | "dispatch" | "label";

const UNRESOLVED_SUBJECT: Readonly<Record<DoorKind, string>> = {
  push: "a git push",
  merge: "a gh pr merge",
  release: "a release command",
  script: "a package script that opens a door",
  dispatch: "a workflow dispatch",
  label: "a label added to a pull request",
};

const EXPLICIT_FORM: Readonly<Record<DoorKind, string>> = {
  push: "Run the push alone, from the repository, with literal names: git push origin <branch>",
  merge:
    "Run it alone, from the repository, with a literal number: gh pr merge <number> (or gh pr merge <number> --repo <owner>/<name>)",
  release:
    "The release is the human's; its plan runs alone, from the repository: bun ./scripts/release.ts --dry-run",
  script: "Run the script's commands themselves, one at a time, with literal names",
  dispatch:
    "Run it alone, from the repository, naming the workflow by its file: gh workflow run <file>.yml",
  label:
    "Run it alone, from the repository, with a literal number and label: gh pr edit <number> --add-label <label>",
};

/** Why a door the guard cannot resolve is refused, with the explicit form that it can. */
export function unresolvedRefusal(kind: DoorKind, why: string): string {
  return `agent-hooks: the guard cannot resolve ${UNRESOLVED_SUBJECT[kind]} in this command: ${why}. ${EXPLICIT_FORM[kind]}.`;
}

/** Why a release command is refused in a repository with a landing profile. */
export function releaseRefusal(command: string, landing: LandingProfile): string {
  return (
    `agent-hooks: ${command} publishes '${landing.release}', and the release is the human's. ` +
    "Say the release is ready and leave it to the human."
  );
}

/** What the guard read of the human's latest typed message in the session. */
export type HumanMessage =
  | { readonly kind: "read"; readonly text: string | null }
  | { readonly kind: "unreadable"; readonly why: string };

const LETTER_OR_DIGIT = "[\\p{L}\\p{N}_]";

/**
 * The first of `phrases` that `text` holds as words of its own, any case, any run of whitespace between them, with
 * `pr` in place of `{pr}`; null when it holds none.
 */
export function approvingPhrase(
  text: string,
  phrases: readonly string[],
  pr: number | null,
): string | null {
  return (
    phrases.find((phrase) => {
      const words = phrase
        .replaceAll("{pr}", String(pr))
        .trim()
        .split(/\s+/u)
        .map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"));

      return new RegExp(
        `(?<!${LETTER_OR_DIGIT})${words.join("\\s+")}(?!${LETTER_OR_DIGIT})`,
        "iu",
      ).test(text);
    }) ?? null
  );
}

function quoted(phrases: readonly string[], pr: number | null): string {
  return phrases.map((phrase) => `"${phrase.replaceAll("{pr}", String(pr))}"`).join(", ");
}

/** Why the human's message does not count, or null when it holds a phrase. */
function unapproved(
  human: HumanMessage,
  phrases: readonly string[],
  pr: number | null,
): string | null {
  if (human.kind === "unreadable") {
    return `the guard cannot read the human's latest message (${human.why})`;
  }

  if (human.text === null) {
    return "the session holds no message the human typed";
  }

  return approvingPhrase(human.text, phrases, pr) === null
    ? `the human's latest message does not say so (it would hold one of ${quoted(phrases, pr)})`
    : null;
}

/** Why dispatching `workflow`'s file is refused; null when the human's latest typed message asks for it. */
export function dispatchRefusal(workflow: Approval, human: HumanMessage): string | null {
  const why = unapproved(human, workflow.phrases, null);

  return why === null
    ? null
    : `agent-hooks: dispatching ${workflow.name} is the human's decision, and ${why}. ` +
        `Ask the human whether to run it, and dispatch it once their own message says so.`;
}

/** Why adding `label` to pull requests `prs` is refused; null when the human's latest typed message approves each. */
export function labelRefusal(
  label: Approval,
  prs: readonly number[] | null,
  human: HumanMessage,
): string | null {
  if (prs === null) {
    return (
      `agent-hooks: the label ${label.name} is the human's ok on one pull request, and this command does not name each it labels by its number. ` +
      `Ask the human for their ok, then add it with gh pr edit <number> --add-label ${label.name}.`
    );
  }

  return (
    prs.map((pr) => prLabelRefusal(label, pr, human)).find((reason) => reason !== null) ?? null
  );
}

function prLabelRefusal(label: Approval, pr: number, human: HumanMessage): string | null {
  const why = unapproved(human, label.phrases, pr);

  return why === null
    ? null
    : `agent-hooks: the label ${label.name} on #${pr} is the human's ok on that pull request, and ${why}. ` +
        `Ask the human for their ok on #${pr}, and add the label once their own message gives it.`;
}
