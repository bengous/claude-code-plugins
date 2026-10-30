/**
 * The floor under a change's review tier: what makes it wait for the human whatever a model says of it. Read by
 * `scripts/tier.ts` before it asks Haiku, and by `scripts/land.ts` on the rebased head of each landing.
 */

import { CONFIG_GIT_PATH } from "../agent-hooks/config.ts";
import { parseProfile } from "../agent-hooks/profile.ts";
import { ConfigError } from "../agent-hooks/reader.ts";
import { isE2ePath } from "./check-e2e-green.ts";
import { BREAKING } from "./lib/breaking-subject.ts";
import { run } from "./lib/run.ts";

/** Past this many lines added and removed, the change waits for the human: too much for one read to vouch for. */
export const LINE_CAP = 400;

export type Tier = "low" | "human";

export interface Verdict {
  readonly tier: Tier;
  readonly reason: string;
}

/** One entry of `git diff --name-status`: its status letter, then its path, or its old and new paths. */
export interface Change {
  readonly status: string;
  readonly paths: readonly string[];
}

export type RiskyRead =
  | { readonly kind: "read"; readonly risky: readonly string[] }
  | { readonly kind: "unreadable"; readonly why: string };

export interface FloorInput {
  readonly changes: readonly Change[];
  readonly subjects: readonly string[];
  readonly risky: RiskyRead;
  readonly lines: number;
}

/** A plugin, skill, agent or command appears or goes with one of these files. */
const COMPONENTS = [
  "**/SKILL.md",
  "**/agents/*.md",
  "**/commands/*.md",
  "**/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
].map((glob) => new Bun.Glob(glob));

/** Hooks and MCP servers, which run in every session that loads them: any change to these files. */
const SESSION_WIDE = ["**/hooks/hooks.json", "**/.mcp.json"].map((glob) => new Bun.Glob(glob));

/** Added, deleted, renamed, copied. */
const STRUCTURAL = new Set(["A", "D", "R", "C"]);

const SHOWN = 3;

/** The profile file in `rev`, as `git show` names it. */
export function profileSpec(rev: string): string {
  return `${rev}:${CONFIG_GIT_PATH}`;
}

/** The risky globs of the profile in `rev`: none only when `rev` holds no profile file or no review in it. */
export function riskyOf(checkout: string, rev: string): RiskyRead {
  const spec = profileSpec(rev);

  const listed = run(
    ["git", "ls-tree", "--full-tree", "--name-only", rev, "--", CONFIG_GIT_PATH],
    checkout,
  );

  if (!listed.ok) return { kind: "unreadable", why: `git ls-tree ${rev}: ${listed.err}` };

  if (listed.out === "") return { kind: "read", risky: [] };

  const shown = run(["git", "show", spec], checkout);

  if (!shown.ok) return { kind: "unreadable", why: `git show ${spec}: ${shown.err}` };

  try {
    return { kind: "read", risky: parseProfile(spec, shown.out).review?.risky ?? [] };
  } catch (error) {
    if (error instanceof ConfigError) return { kind: "unreadable", why: error.message };

    throw error;
  }
}

/** Whether a path is risky, the globs compiled once: every path while the profile does not read. */
export function riskyMatcher(risky: RiskyRead): (path: string) => boolean {
  if (risky.kind === "unreadable") return () => true;

  const globs = risky.risky.map((glob) => new Bun.Glob(glob));

  return (path) => globs.some((glob) => glob.match(path));
}

/** The paths among `paths` that a risky glob matches: all of them while the profile does not read. */
export function riskyPaths(paths: readonly string[], risky: RiskyRead): readonly string[] {
  const isRisky = riskyMatcher(risky);

  return paths.filter((path) => isRisky(path));
}

/** `git diff --name-status -z` read as changes; a rename or a copy carries its old path, then its new one. */
export function changesOf(nameStatus: string): readonly Change[] {
  const fields = nameStatus.split("\0").filter((field) => field !== "");
  const changes: Change[] = [];

  for (let index = 0; index < fields.length;) {
    const status = (fields[index] ?? "").charAt(0);
    const width = status === "R" || status === "C" ? 2 : 1;

    changes.push({ status, paths: fields.slice(index + 1, index + 1 + width) });
    index += 1 + width;
  }

  return changes;
}

/** The lines added and removed in `git diff --numstat -z`, a binary file counting none. */
export function linesOf(numstat: string): number {
  let lines = 0;

  for (const field of numstat.split("\0")) {
    const counts = /^(\d+|-)\t(\d+|-)\t/u.exec(field);

    if (counts !== null) lines += (Number(counts[1]) || 0) + (Number(counts[2]) || 0);
  }

  return lines;
}

function named(paths: readonly string[]): string {
  const shown = paths.slice(0, SHOWN).join(", ");

  return paths.length > SHOWN ? `${shown} and ${paths.length - SHOWN} more` : shown;
}

function human(reason: string): Verdict {
  return { tier: "human", reason };
}

/** Why the change waits for the human whatever is said of it, or null when the floor leaves it to the judge. */
export function floorOf({ changes, subjects, risky, lines }: FloorInput): Verdict | null {
  if (changes.length === 0) return human("the change touches no file");

  if (risky.kind === "unreadable") {
    return human(`the review profile does not read, so every path is risky: ${risky.why}`);
  }

  const paths = [...new Set(changes.flatMap((change) => change.paths))];
  const touched = riskyPaths(paths, risky);

  if (touched.length > 0) return human(`touches a risky path: ${named(touched)}`);

  const e2e = paths.filter((path) => isE2ePath(path));

  if (e2e.length > 0) return human(`touches an e2e path: ${named(e2e)}`);

  const breaking = subjects.find((subject) => BREAKING.test(subject));

  if (breaking !== undefined) return human(`a breaking commit: ${breaking}`);

  const components = changes
    .filter((change) => STRUCTURAL.has(change.status))
    .flatMap((change) =>
      change.paths.filter((path) => COMPONENTS.some((glob) => glob.match(path))),
    );

  if (components.length > 0) {
    return human(`adds, removes or renames a plugin component: ${named(components)}`);
  }

  const sessionWide = paths.filter((path) => SESSION_WIDE.some((glob) => glob.match(path)));

  if (sessionWide.length > 0) return human(`changes hooks or MCP servers: ${named(sessionWide)}`);

  if (lines > LINE_CAP) return human(`${lines} lines changed, past the ${LINE_CAP}-line cap`);

  return null;
}
