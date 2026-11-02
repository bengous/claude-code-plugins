import { existsSync } from "node:fs";

import { isRecord, isStringArray } from "./json.ts";
import type { Reader } from "./reader.ts";
import {
  ConfigError,
  child,
  keyPathOf,
  oneOf,
  parseRecord,
  readText,
  rejectUnknownKeys,
  string,
  stringArray,
} from "./reader.ts";

/** Who moves the trunk: the agents' own pushes, or a server-side action that fast-forwards it to a green pull request. */
export type LandedBy = "agent" | "action";

/** The branches a repository lands on: `trunk`, moved as `by` says, and `release`, moved by the human. */
export type LandingProfile = {
  readonly trunk: string;
  readonly release: string;
  readonly by: LandedBy;
};

/** A door that passes only on one of its phrases in the human's latest typed message: a label's opens a line of it. */
export type Approval = { readonly name: string; readonly phrases: readonly string[] };

/**
 * The human's own slash command that puts a label on, `/<name> <n>`: `targets`, with `{args}` in place of `n`, prints
 * the pull requests that take it, as `{"layers": [{"number": …}, …]}`.
 */
export type LabelCommand = { readonly name: string; readonly targets: string };

/**
 * A label that is the human's ok on a pull request: opened by phrases of the human's latest typed message, or, when a
 * command owns it, by that command alone, which the agent never adds the label in place of.
 */
export type LabelApproval =
  | (Approval & { readonly command: null })
  | { readonly name: string; readonly phrases: readonly []; readonly command: LabelCommand };

/**
 * The doors that wait for the human's words: dispatching each workflow, named by its file, and adding each label to a
 * pull request, whose phrases name it by `{pr}`, or whose command the human types.
 */
export type ApprovalsProfile = {
  readonly workflows: readonly Approval[];
  readonly labels: readonly LabelApproval[];
};

/** The paths a change lands through only with a clean review verdict for exactly that change. */
export type ReviewProfile = { readonly risky: readonly string[] };

/** Whether the agents of a repository share its checkout, or each task takes a worktree of its own. */
export type WorktreeMode = "per-task" | "shared";

/** Whether pre-bash has Haiku judge an agent's commit message before the commit runs. */
export type CommitMessagesMode = "judged";

export type Profile = {
  readonly landing: LandingProfile | null;
  readonly approvals: ApprovalsProfile | null;
  readonly review: ReviewProfile | null;
  readonly worktree: WorktreeMode;
  readonly commitMessages: CommitMessagesMode | null;
};

/** A profile key of the repo file: absent with the file or the key, or unreadable, its error named. */
export type KeyRead<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly error: string };

export type ProfileKeys = {
  readonly landing: KeyRead<LandingProfile>;
  readonly approvals: KeyRead<ApprovalsProfile>;
  readonly commitMessages: KeyRead<CommitMessagesMode>;
  readonly worktree: KeyRead<WorktreeMode>;
};

const ABSENT = { kind: "absent" } as const;

const PROFILE_KEYS = new Set(["landing", "approvals", "review", "worktree", "commitMessages"]);

const LANDING_KEYS = new Set(["trunk", "release", "by"]);

const APPROVALS_KEYS = new Set(["workflows", "labels"]);

const PR_PLACEHOLDER = "{pr}";

const ARGS_PLACEHOLDER = "{args}";

const COMMAND_KEYS = new Set(["command", "targets"]);

const COMMAND_NAME = /^[a-z][\w-]*$/u;

const WORKFLOW_FILE = /^[\w.-]+\.ya?ml$/u;

const REVIEW_KEYS = new Set(["risky"]);

/**
 * The profile keys of the repo file `configFile`, the file read once and each key alone: an error elsewhere in the
 * file, another profile key included, leaves a key readable. Every key is absent without the file, and unreadable,
 * its error named, when the file cannot be read or parsed or its profile is no object.
 */
export function loadProfile(configFile: string): ProfileKeys {
  if (!existsSync(configFile)) {
    return { landing: ABSENT, approvals: ABSENT, commitMessages: ABSENT, worktree: ABSENT };
  }

  const profile = keyOf(() => profileIn(configFile, readText(configFile)));

  if (profile.kind !== "read") {
    return { landing: profile, approvals: profile, commitMessages: profile, worktree: profile };
  }

  return {
    landing: keyOf(() => readLanding(profile.value)),
    approvals: keyOf(() => readApprovals(profile.value)),
    commitMessages: keyOf(() => readCommitMessages(profile.value)),
    worktree: keyOf(() => readWorktree(profile.value)),
  };
}

function keyOf<T>(read: () => T | null): KeyRead<T> {
  try {
    const value = read();

    return value === null ? ABSENT : { kind: "read", value };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { kind: "unreadable", error: error.message };
    }

    throw error;
  }
}

/**
 * The whole profile in `text`, the repo file as `file` names it (a path, or a commit's `<rev>:<path>`), an unknown
 * key included: for a reader that runs the same revision's kit, where an unknown key can only be a typo. Throws a
 * ConfigError naming the key when the text does not parse or its profile is invalid.
 */
export function parseProfile(file: string, text: string): Profile {
  return readProfile(profileIn(file, text));
}

function profileIn(file: string, text: string): Reader {
  return child({ file, record: parseRecord(file, text), keyPath: "" }, "profile");
}

export function readProfile(reader: Reader): Profile {
  rejectUnknownKeys(reader, PROFILE_KEYS);

  return {
    landing: readLanding(reader),
    approvals: readApprovals(reader),
    review: readReview(reader),
    worktree: readWorktree(reader) ?? "shared",
    commitMessages: readCommitMessages(reader),
  };
}

function readWorktree(profile: Reader): WorktreeMode | null {
  return oneOf<WorktreeMode>(profile, "worktree", ["per-task", "shared"]) ?? null;
}

function readCommitMessages(profile: Reader): CommitMessagesMode | null {
  return oneOf<CommitMessagesMode>(profile, "commitMessages", ["judged"]) ?? null;
}

function readLanding(profile: Reader): LandingProfile | null {
  if (profile.record["landing"] === undefined) {
    return null;
  }

  const landing = child(profile, "landing");
  rejectUnknownKeys(landing, LANDING_KEYS);
  const trunk = branch(landing, "trunk");
  const release = branch(landing, "release");

  if (trunk === release) {
    throw new ConfigError(profile.file, landing.keyPath, "trunk and release name one branch");
  }

  return { trunk, release, by: oneOf<LandedBy>(landing, "by", ["agent", "action"]) ?? "agent" };
}

function readApprovals(profile: Reader): ApprovalsProfile | null {
  if (profile.record["approvals"] === undefined) {
    return null;
  }

  const approvals = child(profile, "approvals");
  rejectUnknownKeys(approvals, APPROVALS_KEYS);
  const workflows = readApprovalTable(child(approvals, "workflows"), "workflow");
  const labels = readLabelTable(child(approvals, "labels"));

  if (workflows.length === 0 && labels.length === 0) {
    throw new ConfigError(profile.file, approvals.keyPath, "expected workflows or labels");
  }

  return { workflows, labels };
}

function requiredString(reader: Reader, key: string): string {
  const value = string(reader, key);

  if (value === undefined || value.trim() === "") {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a string");
  }

  return value;
}

/** A table of labels to phrases, or to the command that alone puts the label on, `{"command", "targets"}`. */
function readLabelTable(reader: Reader): LabelApproval[] {
  const byPhrases = Object.fromEntries(
    Object.entries(reader.record).filter(([, value]) => !isRecord(value)),
  );

  const phrased = readApprovalTable({ ...reader, record: byPhrases }, "label").map(
    (approval): LabelApproval => ({ ...approval, command: null }),
  );

  const owners = new Map<string, string>();

  const commanded = Object.keys(reader.record)
    .filter((name) => isRecord(reader.record[name]))
    .map((name): LabelApproval => {
      if (name.trim() === "") {
        throw new ConfigError(reader.file, keyPathOf(reader, name), "expected a label name");
      }

      const entry = child(reader, name);
      rejectUnknownKeys(entry, COMMAND_KEYS);
      const command = requiredString(entry, "command");
      const targets = requiredString(entry, "targets");
      const owner = owners.get(command);

      if (owner !== undefined) {
        throw new ConfigError(
          entry.file,
          keyPathOf(entry, "command"),
          `/${command} already puts ${owner} on: one command owns one label`,
        );
      }

      owners.set(command, name);

      if (!COMMAND_NAME.test(command)) {
        throw new ConfigError(
          entry.file,
          keyPathOf(entry, "command"),
          `expected a slash command's name, as land, not "${command}"`,
        );
      }

      if (!targets.includes(ARGS_PLACEHOLDER)) {
        throw new ConfigError(
          entry.file,
          keyPathOf(entry, "targets"),
          `"${targets}" takes no number: write ${ARGS_PLACEHOLDER} where /${command}'s goes`,
        );
      }

      return { name, phrases: [], command: { name: command, targets } };
    });

  return [...phrased, ...commanded];
}

/** A table of names to phrases: a workflow is its file name, and only a label's phrases name the pull request. */
function readApprovalTable(reader: Reader, kind: "workflow" | "label"): Approval[] {
  return Object.keys(reader.record).map((name) => {
    const keyPath = keyPathOf(reader, name);
    const phrases = reader.record[name];

    if (kind === "workflow" && !WORKFLOW_FILE.test(name)) {
      throw new ConfigError(reader.file, keyPath, "expected a workflow file name, as release.yml");
    }

    if (name.trim() === "") {
      throw new ConfigError(reader.file, keyPath, "expected a label name");
    }

    if (
      !isStringArray(phrases) ||
      phrases.length === 0 ||
      phrases.some((phrase) => phrase.trim() === "")
    ) {
      throw new ConfigError(reader.file, keyPath, "expected a list of phrases");
    }

    for (const phrase of phrases) {
      if (kind === "label" && !phrase.includes(PR_PLACEHOLDER)) {
        throw new ConfigError(
          reader.file,
          keyPath,
          `"${phrase}" names no pull request: write ${PR_PLACEHOLDER} where its number goes`,
        );
      }

      if (kind === "workflow" && phrase.includes(PR_PLACEHOLDER)) {
        throw new ConfigError(
          reader.file,
          keyPath,
          `"${phrase}": ${PR_PLACEHOLDER} names a pull request, which a workflow has none of`,
        );
      }
    }

    return { name, phrases };
  });
}

function readReview(profile: Reader): ReviewProfile | null {
  if (profile.record["review"] === undefined) {
    return null;
  }

  const review = child(profile, "review");
  rejectUnknownKeys(review, REVIEW_KEYS);
  const risky = stringArray(review, "risky");

  const keyPath = keyPathOf(review, "risky");

  if (risky === undefined || risky.length === 0) {
    throw new ConfigError(review.file, keyPath, "expected a list of globs");
  }

  for (const glob of risky) {
    const anchor = ["./", "/"].find((prefix) => glob.startsWith(prefix));

    if (anchor !== undefined) {
      throw new ConfigError(
        review.file,
        keyPath,
        `"${glob}" starts with ${anchor}; a glob is relative to the repository root`,
      );
    }
  }

  return { risky };
}

function branch(reader: Reader, key: string): string {
  const value = string(reader, key);

  if (value === undefined || !/^[^\s:~^?*[\\]+$/u.test(value)) {
    throw new ConfigError(reader.file, keyPathOf(reader, key), "expected a branch name");
  }

  return value;
}
