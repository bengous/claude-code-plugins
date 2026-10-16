import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  COMMAND,
  FINDING_ID,
  type FindingKind,
  FINDINGS_DIR,
  formatRecord,
  parseTarget,
} from "../hooks/findings.ts";

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

function repoOf(cwd: string): Repo {
  const revParse = Bun.spawnSync(
    ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );

  const [top, commonDir] = revParse.stdout.toString().trim().split("\n");

  if (revParse.exitCode !== 0 || top === undefined || commonDir === undefined)
    throw new Error(`${cwd} is not inside a git work tree: ${revParse.stderr.toString().trim()}`);

  return { top: realpathSync(top), buffer: join(commonDir, FINDINGS_DIR) };
}

/** Whether a path relative to the repository's root stays under it: `..env` does, `../x` does not. */
function isInside(fromRoot: string): boolean {
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function newId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function record(args: readonly string[], cwd: string, now: Date): string {
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

  if (!isInside(inside)) throw new Error(`${rawPath} is outside the repository at ${repo.top}`);
  const path = inside === "" ? "." : inside.split(sep).join("/");
  const id = newId();
  const staged = join(repo.buffer, `.${id}.tmp`);

  mkdirSync(repo.buffer, { recursive: true });
  // Renamed into place whole, so the band never reads half a finding.
  writeFileSync(staged, formatRecord({ path, line, why, kind, recordedAt: now.toISOString() }));
  renameSync(staged, join(repo.buffer, `${id}.json`));
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
      if (!(error instanceof Error && "code" in error && error.code === ENOENT)) throw error;
      missing.push(id);
    }
  }

  return {
    exitCode: missing.length === 0 ? 0 : 1,
    stdout: closed.map((id) => `Closed finding ${id}.\n`).join(""),
    stderr: missing.map((id) => `${COMMAND}: no finding ${id} in ${buffer}\n`).join(""),
  };
}

export function run(args: readonly string[], cwd: string, now: Date): Outcome {
  const [first, ...rest] = args;

  try {
    if (first === undefined) throw new UsageError("record a finding, or close one");

    if (first === "--help" || first === "-h") return { exitCode: 0, stdout: USAGE, stderr: "" };

    if (first === "--close") return close(rest, cwd);

    if (first.startsWith("-") && first !== "--security")
      throw new UsageError(`unknown option ${first}`);

    return { exitCode: 0, stdout: record(args, cwd, now), stderr: "" };
  } catch (error) {
    if (error instanceof UsageError)
      return { exitCode: 2, stdout: "", stderr: `${COMMAND}: ${error.message}\n${USAGE}` };

    return {
      exitCode: 1,
      stdout: "",
      stderr: `${COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

if (import.meta.main) {
  const outcome = run(process.argv.slice(2), process.cwd(), new Date());

  process.stdout.write(outcome.stdout);
  process.stderr.write(outcome.stderr);
  process.exit(outcome.exitCode);
}
