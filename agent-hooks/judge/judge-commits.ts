import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { configPath } from "../config.ts";
import { messageOf } from "../errors.ts";
import type { Deadline, Runner } from "../exec.ts";
import { isAbsoluteLocation } from "../guard/doors.ts";
import { note, refusal } from "../guard/judge-doors.ts";
import { git, rootOf } from "../guard/repo.ts";
import { sha256 } from "../hash.ts";
import { stateKey } from "../hook.ts";
import type { Input } from "../payload.ts";
import type { CommitMessagesMode, KeyRead } from "../profile.ts";
import { loadProfile } from "../profile.ts";
import { loadRefused, saveRefused } from "../state.ts";
import { escapeRegExp } from "../text.ts";
import type { PreBashVerdict } from "../verdict.ts";
import { ALLOW } from "../verdict.ts";
import type { Fault, Judgment } from "./commit-judge.ts";
import { commitMessageOf, judge, judgeRefusal, withTrailers } from "./commit-judge.ts";
import type { CommitInvocation } from "./commits.ts";
import { commitsOf } from "./commits.ts";

/** A commit of the line whose message goes to the judge, and the judge's answer once it comes. */
type Judged = {
  readonly message: string;
  readonly hash: string;
  readonly judgment: Promise<Judgment>;
};

/**
 * Records the judge's refusals and gives its verdict. Called only once the landing guard let the line through: a
 * refusal the agent never saw must not let the same message pass unjudged later.
 */
export type Settle = () => PreBashVerdict;

/** What `git diff` lists for the commits of one line in one checkout: read once, before the line runs. */
function filesOf(dir: string, location: readonly string[], takes: "staged" | "worktree"): string[] {
  const args =
    takes === "staged" ? ["diff", "--cached", "--name-only"] : ["diff", "--name-only", "HEAD"];

  return (git(dir, location, args) ?? "").split("\n").filter(Boolean);
}

/**
 * Has Haiku judge the message of each `git commit` the line runs as written in a repository whose profile asks for
 * it: refused when a message tells how the change came about or how it was checked. A message once refused to this
 * agent passes unjudged from then on: the refusal holds once, and a rerun that fails later (a red pre-commit, a
 * denied prompt) is not refused again. A commit that keeps its message, makes none, or whose message the line does
 * not show, is not judged; a judge that gives no answer lets the commit through with a note.
 */
export async function judgeCommits(
  command: string,
  cwd: string,
  input: Input,
  deadline: Deadline,
  runner: Runner,
): Promise<Settle> {
  const notes = new Set<string>();
  const key = stateKey(input);
  let refusedBefore: readonly string[] | null = null;
  const judged: Judged[] = [];
  const profiles = new Map<string, KeyRead<CommitMessagesMode> | null>();
  const filesByCheckout = new Map<string, string[]>();

  for (const commit of commitsOf(command, cwd)) {
    const written = commitMessageOf(commit.git.args, commit.heredoc, commit);
    const dir = commit.cwd ?? (isAbsoluteLocation(commit.git.location) ? "/" : null);

    if (written.form === "kept") {
      continue;
    }

    if (dir === null) {
      const here = rootOf(cwd, []);

      if (here !== null && loadProfile(configPath(here)).commitMessages.kind === "read") {
        notes.add(
          `agent-hooks: a commit went unjudged: an earlier ${commit.lost ?? "cd"} leaves its directory unknown`,
        );
      }

      continue;
    }

    const checkout = `${dir}\u0000${commit.git.location.join("\u0000")}`;

    if (!profiles.has(checkout)) {
      const root = rootOf(dir, commit.git.location);
      profiles.set(checkout, root === null ? null : loadProfile(configPath(root)).commitMessages);
    }

    const read = profiles.get(checkout) ?? null;

    if (read === null || read.kind === "absent") {
      continue;
    }

    if (read.kind === "unreadable") {
      notes.add(`agent-hooks: a commit went unjudged: ${read.error}`);
      continue;
    }

    if (written.opaque) {
      notes.add(UNSEEN_MESSAGE);
      continue;
    }

    const fromFile =
      written.message === null ? messageFileOf(command, commit, dir, written.file, notes) : null;

    const message =
      written.message ?? (fromFile === null ? null : withTrailers(fromFile, written.trailers));

    if (message === null || message === "") {
      continue;
    }

    const hash = sha256(message);
    refusedBefore ??= loadRefused(key);

    if (refusedBefore.includes(hash)) {
      continue;
    }

    const filesKey = `${checkout}\u0000${written.takes}`;
    const files = filesByCheckout.get(filesKey) ?? filesOf(dir, commit.git.location, written.takes);
    filesByCheckout.set(filesKey, files);
    judged.push({ message, hash, judgment: judge(message, files, deadline, runner) });
  }

  const refused: { message: string; hash: string; faults: readonly Fault[] }[] = [];

  for (const { message, hash, judgment } of judged) {
    const answer = await judgment;

    if (answer.kind === "failed") {
      notes.add(noAnswer(answer.why));
    } else if (answer.faults.length > 0) {
      refused.push({ message, hash, faults: answer.faults });
    }
  }

  return () => settled(key, refusedBefore ?? [], refused, notes);
}

function settled(
  key: string,
  refusedBefore: readonly string[],
  refused: readonly { message: string; hash: string; faults: readonly Fault[] }[],
  notes: ReadonlySet<string>,
): PreBashVerdict {
  const noted = [...notes];

  if (refused.length === 0) {
    return noted.length === 0 ? ALLOW : note(noted.join("\n"));
  }

  try {
    saveRefused(key, [...new Set([...refusedBefore, ...refused.map(({ hash }) => hash)])]);
  } catch (error) {
    const why = messageOf(error);

    // A refusal its rerun cannot get past would refuse a legitimate message forever.
    return note(
      [
        ...noted,
        `agent-hooks: the commit judge refused a message but could not save the refusal (${why}): the commit passed`,
      ].join("\n"),
    );
  }

  return refusal([judgeRefusal(refused), ...noted].join("\n"));
}

const UNSEEN_MESSAGE =
  "agent-hooks: a commit went unjudged: part of its message is known only once the line runs";

function noAnswer(why: string): string {
  return `agent-hooks: the commit judge gave no answer (${why}): the commit passed`;
}

/**
 * The message in the file `-F` names, read where git reads it, after its `-C`. None, with a note, when the line names
 * the file's name as a word before the commit, under any spelling of its path: the hook runs ahead of the line, so
 * the file may still hold an older message. None when it is not there, as git then makes no commit; a note when it
 * is too large or cannot be read.
 */
function messageFileOf(
  line: string,
  commit: CommitInvocation,
  dir: string,
  file: string | null,
  notes: Set<string>,
): string | null {
  if (file === null) {
    return null;
  }

  const name = escapeRegExp(path.basename(file));

  if (new RegExp(`(?<![\\w.-])${name}(?![\\w.-])`, "u").test(line.slice(0, commit.start))) {
    notes.add(UNSEEN_MESSAGE);

    return null;
  }

  const gitDir = commit.git.location.reduce(
    (current, value, index) =>
      index % 2 === 1 && commit.git.location[index - 1] === "-C"
        ? path.resolve(current, value)
        : current,
    dir,
  );

  const resolved = path.resolve(gitDir, file);

  try {
    if (!existsSync(resolved)) {
      return null;
    }

    if (statSync(resolved).size > MESSAGE_FILE_BYTES) {
      notes.add(`agent-hooks: a commit went unjudged: ${resolved} is over 64 KiB`);

      return null;
    }

    return readFileSync(resolved, "utf8").trim();
  } catch (error) {
    const message = messageOf(error);
    notes.add(`agent-hooks: a commit went unjudged: ${resolved} cannot be read (${message})`);

    return null;
  }
}

/** A message file past this size is not a commit message the judge needs whole. */
const MESSAGE_FILE_BYTES = 64 * 1024;
