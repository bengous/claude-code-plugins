import { existsSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  COMMAND,
  FINDING_ID,
  type FindingKind,
  FINDINGS_DIR,
  formatRecord,
  parseTarget,
} from "../hooks/findings.ts";
import { createExclusiveSync, gitSync } from "../lib/platform/node.ts";
import { isErrno, isInsideRelative, messageOf } from "../lib/platform/pure.ts";

const USAGE = `Usage:
  ${COMMAND} [--security] <path>[:<line>] <why>   record a finding unrelated to your task, for the user to review in batch
  ${COMMAND} --close <id>...                       remove findings once they are handled
`;

export type Outcome = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type Repo = { readonly top: string; readonly buffer: string };

class UsageError extends Error {}

const ENOENT = "ENOENT";

const ID_DRAWS = 5;

function repoOf(cwd: string): Repo {
  const revParse = gitSync(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    { cwd },
  );

  const [top, commonDir] = revParse.stdout.trim().split("\n");

  if (
    revParse.kind !== "exited" ||
    revParse.code !== 0 ||
    top === undefined ||
    commonDir === undefined
  )
    throw new Error(`${cwd} is not inside a git work tree: ${revParse.stderr.trim()}`);

  return { top: realpathSync(top), buffer: join(commonDir, FINDINGS_DIR) };
}

export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Writes the record aside, then links it under a free id: a link shows the band the file whole, and refuses a name another finding holds. */
function place(buffer: string, text: string, nextId: () => string): string {
  for (let draw = 0; draw < ID_DRAWS; draw += 1) {
    const id = nextId();

    if (createExclusiveSync(join(buffer, `${id}.json`), text)) return id;
  }

  throw new Error(`no free finding id in ${buffer} after ${ID_DRAWS} draws`);
}

function record(args: readonly string[], cwd: string, now: Date, nextId: () => string): string {
  const [first, ...rest] = args;
  const kind: FindingKind = first === "--security" ? "security" : "finding";
  const [target, ...words] = kind === "security" ? rest : args;

  if (target === undefined || target.startsWith("-"))
    throw new UsageError("name the path the finding is about");
  const why = words.join(" ").replaceAll(/\s+/gu, " ").trim();

  if (why === "") throw new UsageError("say why it matters, after the path");
  const { path: rawPath, line } = parseTarget(target);
  const absolute = resolve(cwd, rawPath);

  if (!existsSync(absolute)) throw new Error(`${rawPath}: no such file or directory`);
  const repo = repoOf(cwd);
  const inside = relative(repo.top, realpathSync(absolute));

  if (!isInsideRelative(inside, [sep]))
    throw new Error(`${rawPath} is outside the repository at ${repo.top}`);
  const path = inside === "" ? "." : inside.split(sep).join("/");

  mkdirSync(repo.buffer, { recursive: true });

  const id = place(
    repo.buffer,
    formatRecord({ path, line, why, kind, recordedAt: now.toISOString() }),
    nextId,
  );

  const where = line === null ? path : `${path}:${line}`;

  return `Recorded ${kind === "security" ? "security finding" : "finding"} ${id} at ${where}. The user reviews findings in batch: carry on with your task.\n`;
}

function close(ids: readonly string[], cwd: string): Outcome {
  if (ids.length === 0) throw new UsageError("name the ids to close");
  const malformed = ids.filter((id) => !FINDING_ID.test(id));

  if (malformed.length > 0)
    throw new UsageError(`not a finding id: ${malformed.join(", ")} (8 hex digits)`);
  const { buffer } = repoOf(cwd);
  const closed: string[] = [];
  const missing: string[] = [];

  for (const id of ids) {
    try {
      unlinkSync(join(buffer, `${id}.json`));
      closed.push(id);
    } catch (error) {
      if (!isErrno(error, ENOENT)) throw error;
      missing.push(id);
    }
  }

  return {
    exitCode: missing.length === 0 ? 0 : 1,
    stdout: closed.map((id) => `Closed finding ${id}.\n`).join(""),
    stderr: missing.map((id) => `${COMMAND}: no finding ${id} in ${buffer}\n`).join(""),
  };
}

export function run(
  args: readonly string[],
  cwd: string,
  now: Date,
  nextId: () => string = randomId,
): Outcome {
  const [first, ...rest] = args;

  try {
    if (first === undefined) throw new UsageError("record a finding, or close one");

    if (first === "--help" || first === "-h") return { exitCode: 0, stdout: USAGE, stderr: "" };

    if (first === "--close") return close(rest, cwd);

    if (first.startsWith("-") && first !== "--security")
      throw new UsageError(`unknown option ${first}`);

    return { exitCode: 0, stdout: record(args, cwd, now, nextId), stderr: "" };
  } catch (error) {
    if (error instanceof UsageError)
      return { exitCode: 2, stdout: "", stderr: `${COMMAND}: ${error.message}\n${USAGE}` };

    return {
      exitCode: 1,
      stdout: "",
      stderr: `${COMMAND}: ${messageOf(error)}\n`,
    };
  }
}

export function main(): never {
  const outcome = run(process.argv.slice(2), process.cwd(), new Date());

  process.stdout.write(outcome.stdout);
  process.stderr.write(outcome.stderr);
  process.exit(outcome.exitCode);
}
