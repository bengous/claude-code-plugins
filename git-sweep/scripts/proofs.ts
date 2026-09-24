// Containment proofs: is a branch tip's content already in the base?

import { $ } from "bun";

import { git, gitRead, localRef, type Ref, remoteRef } from "./git.ts";

// How strongly we can prove a branch's content is already in the base:
//   ancestry       — the tip is reachable from base. Nothing is lost, history included.
//   no-merge-delta — merging it into base would change no file. Content is safe;
//                    the intermediate commits are not (squash/rebase/cherry-pick).
//   merged-pr      — the tip adds nothing to a merged pull request whose landing
//                    commit is in the base. Says nothing about whether the base
//                    still holds the content.
//   unproven       — the test did not conclude. NOT a proof of absence.
export type Proven = "ancestry" | "no-merge-delta" | "merged-pr";

export type ProofKind = Proven | "unproven";

// Exit 0 = ancestor, 1 = not, anything else = error (treated as "not proven").
async function isAncestor(ref: Ref, of: Ref): Promise<boolean> {
  return (await git("merge-base", "--is-ancestor", ref, of)).exitCode === 0;
}

// Would merging `ref` into `base` change any file? A tree comparison, not a
// patch-id one: patch-id only sees that a patch once landed, so it would call a
// squash the base later reverted "contained".
async function hasNoMergeDelta(ref: Ref, base: Ref): Promise<boolean> {
  const merged = await git("merge-tree", "--write-tree", base, ref);

  // A conflict exits non-zero and still prints a tree — both checks are needed.
  if (merged.exitCode !== 0) return false;
  const baseTree = await git("rev-parse", `${base}^{tree}`);

  if (baseTree.exitCode !== 0) return false;

  return merged.stdout.split("\n")[0]?.trim() === baseTree.stdout;
}

// A squash or rebase merge that the base has since edited defeats both proofs
// above, and so does a branch rebased and landed from another checkout: the
// local tip is no longer an ancestor and a three-way merge conflicts. The
// merged pull request links the two, compared against its head, never against
// the base, so the revert trap on hasNoMergeDelta stays out.
export type GithubVerdict = { proven: true } | { proven: false; report: string | null };

export type GithubProver = (ref: Ref, branch: string, base: Ref) => Promise<GithubVerdict>;

type MergedPull = { number: number; headRefName: string; headRefOid: string; mergeCommit: string };

// One entry of `gh pr list --json number,headRefName,headRefOid,mergeCommit`.
type ListedPull = Omit<MergedPull, "mergeCommit"> & { mergeCommit: { oid: string } };

// One entry of the REST `commits/{sha}/pulls` answer.
type PullRef = {
  number: number;
  merged_at: string | null;
  head: { ref: string; sha: string };
  merge_commit_sha: string | null;
};

const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{40})/gu;

const OID = /^[0-9a-f]{40}$/u;

async function gh(...args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const { stdout, exitCode } = await $`gh ${args}`.quiet().nothrow();

  return { stdout: stdout.toString().trim(), exitCode };
}

/* oxlint-disable anti-slop/no-runtime-typeof -- this IS the boundary parser the rule asks for: it validates the GitHub payloads before any proof reads them, and gh hands them over as text, so there is no earlier place to parse. */

// The oids become git arguments: only a full hex sha passes.
const isOid = (value: unknown): value is string => typeof value === "string" && OID.test(value);

function isListedPull(value: unknown): value is ListedPull {
  if (typeof value !== "object" || value === null) return false;

  if (!("number" in value) || typeof value.number !== "number") return false;

  if (!("headRefName" in value) || typeof value.headRefName !== "string") return false;

  if (!("headRefOid" in value) || !isOid(value.headRefOid)) return false;

  if (
    !("mergeCommit" in value) ||
    typeof value.mergeCommit !== "object" ||
    value.mergeCommit === null
  ) {
    return false;
  }

  return "oid" in value.mergeCommit && isOid(value.mergeCommit.oid);
}

function isPullRef(value: unknown): value is PullRef {
  if (typeof value !== "object" || value === null) return false;

  if (!("number" in value) || typeof value.number !== "number") return false;

  if (
    !("merged_at" in value) ||
    (value.merged_at !== null && typeof value.merged_at !== "string")
  ) {
    return false;
  }

  if (
    !("merge_commit_sha" in value) ||
    (value.merge_commit_sha !== null && !isOid(value.merge_commit_sha))
  ) {
    return false;
  }

  if (!("head" in value) || typeof value.head !== "object" || value.head === null) return false;

  return (
    "ref" in value.head &&
    typeof value.head.ref === "string" &&
    "sha" in value.head &&
    isOid(value.head.sha)
  );
}

/* oxlint-enable anti-slop/no-runtime-typeof -- end of the GitHub payload parser. */

// Text that does not parse is no signal, like a failed call.
function parseList<T>(text: string, isEntry: (value: unknown) => value is T): T[] {
  try {
    const parsed: unknown = JSON.parse(text);

    return Array.isArray(parsed) ? parsed.filter((entry) => isEntry(entry)) : [];
  } catch {
    return [];
  }
}

const fromRest = (pull: PullRef): MergedPull | null =>
  pull.merged_at === null || pull.merge_commit_sha === null
    ? null
    : {
        number: pull.number,
        headRefName: pull.head.ref,
        headRefOid: pull.head.sha,
        mergeCommit: pull.merge_commit_sha,
      };

// Any non-zero exit is "no signal", never an error: an unknown commit answers
// HTTP 422, and a missing or unauthenticated gh answers the same way.
async function pullsFor(repo: string, sha: string): Promise<PullRef[]> {
  const response = await gh("api", `repos/${repo}/commits/${sha}/pulls`);

  return response.exitCode === 0 ? parseList(response.stdout, isPullRef) : [];
}

// One call for the whole audit, bounded by the window that already bounds the
// containment test: a branch young enough to be tested merged inside it.
async function mergedByBranch(
  repo: string,
  maxAgeDays: number,
): Promise<Map<string, MergedPull[]>> {
  const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);

  const response = await gh(
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--search",
    `merged:>=${since}`,
    "--limit",
    "1000",
    "--json",
    "number,headRefName,headRefOid,mergeCommit",
  );

  const byBranch = new Map<string, MergedPull[]>();

  if (response.exitCode !== 0) return byBranch;

  for (const { mergeCommit, ...listed } of parseList(response.stdout, isListedPull)) {
    const pull = { ...listed, mergeCommit: mergeCommit.oid };
    byBranch.set(pull.headRefName, [...(byBranch.get(pull.headRefName) ?? []), pull]);
  }

  return byBranch;
}

const PULL_HISTORY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits { totalCount }
      timelineItems(itemTypes: HEAD_REF_FORCE_PUSHED_EVENT, first: 100) {
        nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } }
      }
    }
  }
}`;

// How many commits the final head holds, and every head a force-push replaced.
type PullHistory = { commits: number; formerHeads: Set<string> };

const HISTORY_LINE = /^(commits|former) (\S+)$/u;

// gh's own jq flattens the nesting to tagged lines: `commits <n>`, `former <oid>`.
async function pullHistory(repo: string, number: number): Promise<PullHistory | null> {
  const [owner = "", name = ""] = repo.split("/");

  const response = await gh(
    "api",
    "graphql",
    "-f",
    `query=${PULL_HISTORY}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${number}`,
    "--jq",
    '.data.repository.pullRequest | "commits \\(.commits.totalCount)", (.timelineItems.nodes[].beforeCommit.oid // empty | "former \\(.)")',
  );

  if (response.exitCode !== 0) return null;
  let commits: number | null = null;
  const formerHeads = new Set<string>();

  for (const line of response.stdout.split("\n")) {
    const [, tag, value = ""] = HISTORY_LINE.exec(line) ?? [];

    if (tag === "commits" && /^\d+$/u.test(value)) commits = Number(value);
    else if (tag === "former" && isOid(value)) formerHeads.add(value);
  }

  return commits === null ? null : { commits, formerHeads };
}

async function hasCommit(oid: string): Promise<boolean> {
  return (await git("rev-parse", "--verify", "--quiet", `${oid}^{commit}`)).exitCode === 0;
}

// A deleted branch's head stays fetchable from the pull request's own ref.
async function ensureHead(pull: MergedPull): Promise<boolean> {
  if (await hasCommit(pull.headRefOid)) return true;
  await git("fetch", "--no-write-fetch-head", "origin", `refs/pull/${pull.number}/head`);

  return hasCommit(pull.headRefOid);
}

// git cherry and range-diff both skip merge commits, so a range they judge must
// hold none: work a merge carries of its own would pass unread. A range git
// cannot resolve counts as holding one.
async function mergeFree(range: string): Promise<boolean> {
  const merges = await git("rev-list", "--merges", "--count", range);

  return merges.exitCode === 0 && merges.stdout === "0";
}

// Every commit of the tip has its patch in the head, or the tip is behind it.
async function cherryClean(head: string, tip: string): Promise<boolean> {
  const cherry = await git("cherry", head, tip);

  return cherry.exitCode === 0 && !cherry.stdout.split("\n").some((line) => line.startsWith("+"));
}

// The tip's commits, as `<short sha> <subject>`, sorted by how they meet the head.
type RangeDiff = { matched: number; modified: string[]; missing: string[] };

const RANGE_DIFF_LINE =
  /^\s*(?:\d+|-):\s+([0-9a-f]+|-+) ([=!<>])\s+(?:\d+|-):\s+(?:[0-9a-f]+|-+) (.*)$/u;

// The tip's commits on the left, where git prints their subject: `=` a commit
// with its twin among the pull request's own commits, `!` one a conflict
// changed, `<` one the pull request does not carry. The right side holds only
// the pull request's commits: against the whole head, a dropped commit could
// pair with a base commit the rebase brought in.
async function rangeDiff(tipCommits: string, pullCommits: string): Promise<RangeDiff | null> {
  const output = await git("range-diff", "--no-color", "--no-patch", tipCommits, pullCommits);

  if (output.exitCode !== 0) return null;
  const diff: RangeDiff = { matched: 0, modified: [], missing: [] };

  for (const line of output.stdout.split("\n")) {
    const [, sha, marker, subject] = RANGE_DIFF_LINE.exec(line) ?? [];
    const commit = `${sha} ${subject}`;

    if (marker === "=") diff.matched += 1;
    else if (marker === "!") diff.modified.push(commit);
    else if (marker === "<") diff.missing.push(commit);
  }

  return diff;
}

const listed = (label: string, commits: string[]): string =>
  commits.length === 0 ? `0 ${label}` : `${commits.length} ${label} (${commits.join(", ")})`;

function describeDiff(pull: MergedPull, diff: RangeDiff): string {
  const total = diff.matched + diff.modified.length + diff.missing.length;

  return `PR #${pull.number}: ${diff.matched}/${total} commits match its head, ${listed("modified", diff.modified)}, ${listed("missing", diff.missing)}`;
}

// A merged pull request the base later reverted proves nothing. The revert is
// found by `git revert`'s own message, within the window that already bounds
// the containment test: a branch young enough to be tested has a younger revert.
async function revertedPullNumbers(
  repo: string,
  base: string,
  maxAgeDays: number,
): Promise<Set<number>> {
  const refs: Ref[] = [localRef(base)];
  const remoteBase = remoteRef(`origin/${base}`);

  if ((await git("rev-parse", "--verify", remoteBase)).exitCode === 0) refs.push(remoteBase);

  const reverted = new Set<number>();
  const log = await git("log", ...refs, `--since=${maxAgeDays} days ago`, "--format=%B");

  if (log.exitCode !== 0) return reverted;

  for (const [, sha] of log.stdout.matchAll(REVERTS_COMMIT)) {
    for (const pull of await pullsFor(repo, sha!)) reverted.add(pull.number);
  }

  return reverted;
}

type GithubContext = {
  repo: string;
  reverted: Set<number>;
  byBranch: Map<string, MergedPull[]>;
};

const NO_SIGNAL: GithubVerdict = { proven: false, report: null };

// The repo probe, the revert scan and the merged list run once, on the first
// still-unproven branch, and never again — a repo with nothing unproven pays
// nothing.
export function makeGithubProver(base: string, maxAgeDays: number): GithubProver {
  let context: Promise<GithubContext | null> | null = null;
  const histories = new Map<number, Promise<PullHistory | null>>();

  const resolveContext = async (): Promise<GithubContext | null> => {
    // Same gate as the remote scan: no origin -> fully local, no network.
    if ((await git("remote", "get-url", "origin")).exitCode !== 0) return null;

    // gh resolves owner/repo from the remote itself, so ssh, https and
    // `insteadOf` rewrites all work with no URL parsing here. The charset of
    // the capture is also what makes the value safe in an API path.
    const view = await gh("repo", "view", "--json", "nameWithOwner");

    if (view.exitCode !== 0) return null;

    const repo = view.stdout.match(/"nameWithOwner"\s*:\s*"([\w.-]+\/[\w.-]+)"/u)?.[1];

    if (repo === undefined) return null;

    return {
      repo,
      reverted: await revertedPullNumbers(repo, base, maxAgeDays),
      byBranch: await mergedByBranch(repo, maxAgeDays),
    };
  };

  const historyOf = (repo: string, pull: MergedPull): Promise<PullHistory | null> => {
    let history = histories.get(pull.number);

    if (history === undefined) {
      history = pullHistory(repo, pull.number);
      histories.set(pull.number, history);
    }

    return history;
  };

  return async (ref: Ref, branch: string, landingBase: Ref) => {
    context ??= resolveContext();
    const resolved = await context;

    if (resolved === null) return NO_SIGNAL;
    const tip = await git("rev-parse", ref);

    if (tip.exitCode !== 0) return NO_SIGNAL;

    // By name first; the tip lookup still finds a branch renamed locally.
    const byTip = (await pullsFor(resolved.repo, tip.stdout)).map((found) => fromRest(found));
    const candidates = new Map<number, MergedPull>();

    for (const pull of [...(resolved.byBranch.get(branch) ?? []), ...byTip]) {
      if (pull !== null) candidates.set(pull.number, pull);
    }

    let best: { pull: MergedPull; diff: RangeDiff } | null = null;

    for (const pull of candidates.values()) {
      if (resolved.reverted.has(pull.number)) continue;

      // The landing commit is the head itself after a fast-forward and a
      // commit GitHub recreated after a squash or a stacked merge: in every
      // case, and whatever the pull request's base, it is what the base holds.
      if (
        (await git("merge-base", "--is-ancestor", pull.mergeCommit, landingBase)).exitCode !== 0
      ) {
        continue;
      }

      if (!(await ensureHead(pull))) continue;
      const head = pull.headRefOid;
      const tipCommits = `${head}..${tip.stdout}`;

      if (!(await mergeFree(tipCommits))) continue;

      if (await cherryClean(head, tip.stdout)) return { proven: true };
      const history = await historyOf(resolved.repo, pull);

      if (history === null) continue;

      // The head's last `commits` commits are the pull request's own, as long
      // as no merge sits among them.
      const pullCommits = `${head}~${history.commits}..${head}`;

      if (!(await mergeFree(pullCommits))) continue;
      const diff = await rangeDiff(tipCommits, pullCommits);

      if (diff === null) continue;

      // A former head was in the pull request as a whole, whatever conflicts
      // the landing rebase resolved; a commit dropped from it since is not.
      if (diff.missing.length === 0 && history.formerHeads.has(tip.stdout)) {
        return { proven: true };
      }

      if (best === null || diff.matched > best.diff.matched) best = { pull, diff };
    }

    return { proven: false, report: best === null ? null : describeDiff(best.pull, best.diff) };
  };
}

export type Containment = { proof: ProofKind; report: string | null };

export async function proveContained(
  ref: Ref,
  branch: string,
  base: Ref,
  github: GithubProver | null,
): Promise<Containment> {
  if (await isAncestor(ref, base)) return { proof: "ancestry", report: null };

  if (await hasNoMergeDelta(ref, base)) return { proof: "no-merge-delta", report: null };

  if (github === null) return { proof: "unproven", report: null };
  const verdict = await github(ref, branch, base);

  return verdict.proven
    ? { proof: "merged-pr", report: null }
    : { proof: "unproven", report: verdict.report };
}

// `git branch -d` refuses unless the tip is contained in the branch's upstream,
// or in HEAD when no upstream is set or its ref is gone. A branch fully merged
// into the base still fails when its remote counterpart has diverged — the
// audit predicts that here so the operation can carry a justified force flag
// instead of failing at apply. Returns what -d would measure against.
export async function predictDashDRefusal(branch: string): Promise<string | null> {
  const [upstream = "", upstreamShort = ""] = (
    await gitRead("for-each-ref", "--format=%(upstream)%00%(upstream:short)", localRef(branch))
  ).split("\0");

  const upstreamResolves =
    upstream !== "" && (await git("rev-parse", "--verify", "--quiet", upstream)).exitCode === 0;

  const [target, label] = upstreamResolves ? [upstream, upstreamShort] : ["HEAD", "HEAD"];

  const check = await git("merge-base", "--is-ancestor", localRef(branch), target);

  // Only a definite "not an ancestor" (exit 1) predicts refusal; an error leaves
  // the safe flag in place and lets `-d` speak for itself.
  return check.exitCode === 1 ? label : null;
}
