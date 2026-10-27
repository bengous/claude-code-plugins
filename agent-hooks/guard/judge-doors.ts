import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Approval } from "../config.ts";
import { loadApprovals } from "../config.ts";
import type { Deadline } from "../exec.ts";
import type { Input } from "../hook.ts";
import type { GhCommand, GitCommand, PushTarget, ReleaseScript } from "./argv.ts";
import { isReleaseCreate, pushOf, resolveTargets } from "./argv.ts";
import { assess } from "./doors.ts";
import {
  githubSlugOf,
  pullRequestOf,
  repoFactsOf,
  slugOfPullRequest,
  slugOfRepoOption,
} from "./github.ts";
import type { Door } from "./mentions.ts";
import type { HumanMessage } from "./refusals.ts";
import {
  dispatchRefusal,
  labelRefusal,
  profiledMergeRefusal,
  profiledPushRefusal,
  publicMergeRefusal,
  publicPushRefusal,
  releaseRefusal,
  unreadableProfileRefusal,
  unresolvedRefusal,
} from "./refusals.ts";
import {
  DEFAULT,
  defaultRemote,
  git,
  keyRead,
  profileOf,
  pushBranch,
  remoteUrl,
  rootOf,
} from "./repo.ts";
import { readHuman } from "./transcript.ts";
import { manifestOf, scriptCommands, vocabularyOf } from "./vocabulary.ts";

export type GuardVerdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "deny"; readonly reason: string };

export const ALLOW: GuardVerdict = { kind: "allow" };

/** How deep a package script that runs another one is read: past it, a loop of scripts stops being followed. */
const MAX_SCRIPT_DEPTH = 4;

export type GuardContext = {
  readonly sessionId: string;
  readonly now: number;
  readonly deadline: Deadline;
  /** Where the hook's command runs: a door that names its repository is judged there too, wherever the line went. */
  readonly cwd: string;
  /** The human's latest typed message, read from the transcript the first time a gated door asks. */
  readonly human: () => HumanMessage;
};

export function refusal(reason: string | null): GuardVerdict {
  return reason === null ? ALLOW : { kind: "deny", reason };
}

export function note(text: string): GuardVerdict {
  return { kind: "note", text };
}

async function judgePush(
  cwd: string,
  command: GitCommand,
  context: GuardContext,
): Promise<GuardVerdict> {
  const push = pushOf(command.args);
  const root = push === null ? null : rootOf(cwd, command.location);

  if (push === null || root === null) {
    return ALLOW;
  }

  const branch = git(cwd, command.location, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  const targets = resolveTargets(push.targets, {
    current: branch,
    push: pushBranch(cwd, command.location),
  });

  if (targets.length === 0) {
    return ALLOW;
  }

  const profile = profileOf(root);

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, "git push"));
  }

  if (profile.kind === "profiled") {
    return refusal(profiledPushRefusal(targets, profile.landing, profile.landScript));
  }

  const url = remoteUrl(
    cwd,
    command.location,
    push.remote ?? defaultRemote(cwd, command.location, branch),
  );

  const slug = url === null ? null : githubSlugOf(url);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the push went unchecked`,
      )
    : refusal(publicPushRefusal(targets, facts.value, slug));
}

/** Whether `gh --repo <repo>` names the repository the origin remote of `cwd` points to. */
function isOriginOf(cwd: string, repo: string): boolean {
  const origin = remoteUrl(cwd, [], "origin");
  const originSlug = origin === null ? null : githubSlugOf(origin);
  const named = slugOfRepoOption(repo);

  return originSlug !== null && named?.toLowerCase() === originSlug.toLowerCase();
}

async function judgeGh(
  cwd: string,
  command: GhCommand,
  context: GuardContext,
): Promise<GuardVerdict> {
  const root = rootOf(cwd, []);
  const own = command.repo === null || isOriginOf(cwd, command.repo);
  const profile = root === null || !own ? DEFAULT : profileOf(root);
  const name = isReleaseCreate(command) ? "gh release create" : "gh pr merge";

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, name));
  }

  if (isReleaseCreate(command)) {
    return profile.kind === "profiled" ? refusal(releaseRefusal(name, profile.landing)) : ALLOW;
  }

  const selector = command.positionals[0] ?? null;
  const pr = await pullRequestOf(cwd, selector, command.repo, context.deadline);

  if (pr.kind === "failed") {
    return note(
      `agent-hooks: could not read the pull request gh pr merge names (${pr.why}): the merge went unchecked`,
    );
  }

  if (profile.kind === "profiled") {
    return refusal(profiledMergeRefusal(pr.value, profile.landing, profile.landScript));
  }

  const slug = slugOfPullRequest(pr.value.url);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the merge went unchecked`,
      )
    : refusal(publicMergeRefusal(pr.value, facts.value, slug));
}

/** A ref `gh api` moves, judged as the push it is: by the profile when it names the cwd's repository. */
async function judgeApiRef(
  cwd: string,
  targets: readonly PushTarget[],
  repo: string | null,
  context: GuardContext,
): Promise<GuardVerdict> {
  const root = rootOf(cwd, []);
  const own = repo === null || isOriginOf(cwd, repo);
  const profile = root === null || !own ? DEFAULT : profileOf(root);

  if (profile.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(profile.error, "gh api"));
  }

  if (profile.kind === "profiled") {
    return refusal(profiledPushRefusal(targets, profile.landing, profile.landScript));
  }

  const origin = remoteUrl(cwd, [], "origin");

  const slug =
    repo === null ? (origin === null ? null : githubSlugOf(origin)) : slugOfRepoOption(repo);

  if (slug === null) {
    return ALLOW;
  }

  const facts = await repoFactsOf(slug, context.sessionId, cwd, context.deadline, context.now);

  return facts.kind === "failed"
    ? note(
        `agent-hooks: could not read whether ${slug} is public (${facts.why}): the gh api call went unchecked`,
      )
    : refusal(publicPushRefusal(targets, facts.value, slug));
}

/** The workflow file a dispatch selector names: its file, its path, or the `name:` its file declares at top level. */
function workflowOf(
  selector: string,
  workflows: readonly Approval[],
  root: string,
): Approval | undefined {
  const wanted = selector.toLowerCase();

  return workflows.find((workflow) => {
    const file = path.join(root, ".github", "workflows", workflow.name);

    const declared = existsSync(file)
      ? /^name:\s*(["']?)(.*?)\1\s*(?:#.*)?$/mu.exec(readFileSync(file, "utf8"))?.[2]
      : undefined;

    return [workflow.name, `.github/workflows/${workflow.name}`, declared]
      .filter((name) => name !== undefined)
      .some((name) => name.toLowerCase() === wanted);
  });
}

/**
 * A workflow dispatch or a label added, judged by profile.approvals when it names the cwd's repository: a gated one
 * passes only on the human's latest typed message.
 */
function judgeGated(
  door: Door & { readonly kind: "dispatch" | "label" },
  context: GuardContext,
): GuardVerdict {
  const { repo } = door;

  const dir = (repo === null ? [door.cwd] : [door.cwd, context.cwd]).find(
    (candidate) => repo === null || (existsSync(candidate) && isOriginOf(candidate, repo)),
  );

  const root = dir === undefined ? null : rootOf(dir, []);
  const read = root === null ? null : keyRead(root, loadApprovals);
  const name = door.kind === "dispatch" ? "a workflow dispatch" : "a label";

  if (read?.kind === "unreadable") {
    return refusal(unreadableProfileRefusal(read.error, name, "approvals"));
  }

  if (read?.kind !== "read" || root === null) {
    return ALLOW;
  }

  if (door.kind === "dispatch") {
    const workflow = workflowOf(door.workflow, read.value.workflows, root);

    if (workflow === undefined && /^\d+$/u.test(door.workflow) && read.value.workflows.length > 0) {
      return refusal(
        `agent-hooks: the guard cannot tell which workflow the id ${door.workflow} names. ` +
          `Name it by its file: gh workflow run <file>.yml.`,
      );
    }

    return workflow === undefined ? ALLOW : refusal(dispatchRefusal(workflow, context.human()));
  }

  const wanted = new Set(door.labels.map((label) => label.toLowerCase()));
  const label = read.value.labels.find((entry) => wanted.has(entry.name.toLowerCase()));

  return label === undefined ? ALLOW : refusal(labelRefusal(label, door.prs, context.human()));
}

/**
 * The human's latest typed message, read from the session's own transcript, a subagent's included: its lead's and its
 * own messages are not the human's. Unreadable while the transcript does not hold the turn's prompt yet.
 */
export function humanOf(input: Input | null): HumanMessage {
  if (input?.transcriptPath === undefined) {
    return { kind: "unreadable", why: "the hook received no transcript_path" };
  }

  try {
    const human = readHuman(input.transcriptPath, input.promptId);

    return input.promptId !== undefined && !human.holdsPrompt
      ? { kind: "unreadable", why: "the transcript does not hold this turn's prompt yet: retry" }
      : { kind: "read", text: human.latestTyped };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return {
      kind: "unreadable",
      why: `the transcript ${input.transcriptPath} cannot be read (${message})`,
    };
  }
}

function judgeReleaseScript(release: ReleaseScript): GuardVerdict {
  const root = rootOf(path.dirname(release.path), []);
  const profile = root === null ? DEFAULT : profileOf(root);

  switch (profile.kind) {
    case "unreadable": {
      return refusal(unreadableProfileRefusal(profile.error, release.script));
    }

    case "profiled": {
      return refusal(releaseRefusal(release.script, profile.landing));
    }

    case "default": {
      return ALLOW;
    }

    default: {
      const unreachable: never = profile;
      throw new Error(`unhandled profile: ${JSON.stringify(unreachable)}`);
    }
  }
}

function judgeDoor(door: Door, context: GuardContext, depth: number): Promise<GuardVerdict> {
  switch (door.kind) {
    case "push": {
      return judgePush(door.cwd, door.git, context);
    }

    case "merge":
    case "release-create": {
      return judgeGh(door.cwd, door.gh, context);
    }

    case "release-script": {
      return Promise.resolve(judgeReleaseScript(door.release));
    }

    case "api-ref": {
      return judgeApiRef(door.cwd, door.targets, door.repo, context);
    }

    case "dispatch":
    case "label": {
      return Promise.resolve(judgeGated(door, context));
    }

    case "script": {
      const manifest = manifestOf(door.script.cwd);

      if (manifest === null || depth >= MAX_SCRIPT_DEPTH) {
        return Promise.resolve(ALLOW);
      }

      return Promise.all(
        scriptCommands(door.script, manifest).map((command) =>
          judgeLine(command, manifest.dir, context, depth + 1),
        ),
      ).then(combine);
    }

    default: {
      const unreachable: never = door;
      throw new Error(`unhandled door: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Judges one Bash line: a door mention the guard cannot resolve is refused with the explicit form it can; each
 * resolved door is judged by the profile of its repository, or the public default.
 */
export async function judgeLine(
  command: string,
  cwd: string,
  context: GuardContext,
  depth: number,
): Promise<GuardVerdict> {
  const { doors, unresolved } = assess(command, cwd, vocabularyOf(command, cwd));
  const first = unresolved[0];

  if (first !== undefined) {
    return refusal(unresolvedRefusal(first.kind, first.why));
  }

  return combine(await Promise.all(doors.map((door) => judgeDoor(door, context, depth))));
}

/** The first refusal among the verdicts, else their notes joined, else an allow. */
export function combine(verdicts: readonly GuardVerdict[]): GuardVerdict {
  const denied = verdicts.find((verdict) => verdict.kind === "deny");

  if (denied !== undefined) {
    return denied;
  }

  const notes = verdicts.flatMap((verdict) => (verdict.kind === "note" ? [verdict.text] : []));

  return notes.length === 0 ? ALLOW : { kind: "note", text: notes.join("\n") };
}
