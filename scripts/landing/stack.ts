/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this module IS the parser of what `gh` prints of pull requests and stacks: each reader narrows one field of a JSON record and refuses one of another shape. */
/**
 * What `land.ts <n>` lands, bottom to top: a pull request with the layers under it down to `dev`, read by its base
 * branch's open pull request, or the open layers of a GitHub stack. A number is read both ways, since a stack takes
 * its number from the pull requests' sequence; one that is both is refused. The stacks endpoint is a public preview:
 * a field it stops answering is refused here, never guessed.
 */

import { isRecord, recordField, stringField } from "../../agent-hooks/json.ts";
import { messageOf } from "../../tools/platform/pure.ts";
import type { Gh } from "./ci-wait.ts";
import { DEV } from "./review-verdict.ts";

/** One pull request of what lands: its branch, the base it is open against, its head on GitHub. */
export interface Layer {
  readonly number: number;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly draft: boolean;
}

export type Target =
  | { readonly kind: "layers"; readonly layers: readonly Layer[]; readonly stack: number | null }
  | { readonly kind: "refused"; readonly why: string };

const PR_FIELDS = "number,state,baseRefName,headRefName,headRefOid,isDraft";

const NOT_A_PULL_REQUEST = /Could not resolve to a PullRequest/u;

const NOT_FOUND = /HTTP 404/u;

interface PullRequest extends Layer {
  readonly state: string;
}

function refused(why: string): Target {
  return { kind: "refused", why };
}

function fieldError(what: string, field: string, value: unknown): Error {
  return new Error(`${what} has no ${field} that reads: ${JSON.stringify(value)}`);
}

function numberOf(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isInteger(value)) throw fieldError(what, key, record);

  return value;
}

function stringOf(record: Record<string, unknown>, key: string, what: string): string {
  const value = stringField(record, key);

  if (value === undefined || value === "") throw fieldError(what, key, record);

  return value;
}

function booleanOf(record: Record<string, unknown>, key: string, what: string): boolean {
  const value = record[key];

  if (typeof value !== "boolean") throw fieldError(what, key, record);

  return value;
}

function pullRequestFrom(value: unknown): PullRequest {
  const what = "a pull request gh printed";

  if (!isRecord(value)) throw fieldError(what, "object", value);

  return {
    number: numberOf(value, "number", what),
    state: stringOf(value, "state", what),
    branch: stringOf(value, "headRefName", what),
    base: stringOf(value, "baseRefName", what),
    head: stringOf(value, "headRefOid", what),
    draft: booleanOf(value, "isDraft", what),
  };
}

function parsed(out: string, what: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`gh printed no ${what}: ${out.trim()}`);
  }
}

/** The pull request numbered `n`, or null when GitHub has none by that number. */
async function pullRequestOf(gh: Gh, n: number): Promise<PullRequest | null> {
  let out: string;

  try {
    out = await gh(["pr", "view", String(n), "--json", PR_FIELDS]);
  } catch (error) {
    if (NOT_A_PULL_REQUEST.test(messageOf(error))) return null;
    throw error;
  }

  return pullRequestFrom(parsed(out, `pull request #${n}`));
}

/**
 * The number of `branch`'s pull request when it is based on another branch than `dev`, as a layer of a stack is; null
 * when it is based on `dev`, or when gh reads none, which the branch's own landing then refuses with its reason.
 */
export async function layerNumber(gh: Gh, branch: string): Promise<number | null> {
  try {
    const pr = pullRequestFrom(
      parsed(await gh(["pr", "view", branch, "--json", PR_FIELDS]), `pull request of ${branch}`),
    );

    return pr.base === DEV ? null : pr.number;
  } catch {
    return null;
  }
}

/** The open pull requests whose head is `branch`. */
async function openWithHead(gh: Gh, branch: string): Promise<readonly PullRequest[]> {
  const out = await gh(["pr", "list", "--head", branch, "--state", "open", "--json", PR_FIELDS]);
  const listed = parsed(out, `pull request list for ${branch}`);

  if (!Array.isArray(listed))
    throw fieldError(`the list of pull requests on ${branch}`, "array", listed);

  return listed.map((value) => pullRequestFrom(value));
}

/** The stack numbered `n` as the REST endpoint gives it, its open layers bottom to top, or null when there is none. */
async function stackOf(gh: Gh, n: number): Promise<readonly PullRequest[] | null> {
  let out: string;

  try {
    out = await gh(["api", `repos/{owner}/{repo}/stacks/${n}`]);
  } catch (error) {
    if (NOT_FOUND.test(messageOf(error))) return null;
    throw error;
  }

  const what = `stack #${n}`;
  const stack = parsed(out, what);

  if (!isRecord(stack) || !Array.isArray(stack["pull_requests"])) {
    throw fieldError(what, "pull_requests", stack);
  }

  return stack["pull_requests"].flatMap((entry: unknown) => {
    const layer = `a pull request of ${what}`;

    if (!isRecord(entry)) throw fieldError(layer, "object", entry);

    const head = recordField(entry, "head");
    const base = recordField(entry, "base");

    if (head === undefined) throw fieldError(layer, "head", entry);

    if (base === undefined) throw fieldError(layer, "base", entry);

    const state = stringOf(entry, "state", layer);

    return state === "open"
      ? [
          {
            number: numberOf(entry, "number", layer),
            state,
            branch: stringOf(head, "ref", layer),
            base: stringOf(base, "ref", layer),
            head: stringOf(head, "sha", layer),
            draft: booleanOf(entry, "draft", layer),
          },
        ]
      : [];
  });
}

function layerOf({ number, branch, base, head, draft }: PullRequest): Layer {
  return { number, branch, base, head, draft };
}

/** Null when `layers` stack on one another down to `dev`, bottom first; else why they do not. */
export function chainRefusal(layers: readonly Layer[]): string | null {
  const [bottom] = layers;

  if (bottom === undefined) return "no open pull request to land";

  if (bottom.base !== DEV)
    return `#${bottom.number}, the lowest layer, is based on ${bottom.base}, not ${DEV}`;

  for (const [index, layer] of layers.entries()) {
    const under = layers[index - 1];

    if (under !== undefined && layer.base !== under.branch) {
      return `#${layer.number} is based on ${layer.base}, not on ${under.branch} of #${under.number} under it`;
    }
  }

  return null;
}

/** The pull request `top` and the open pull requests under it, each found by the branch the one above is based on. */
async function chainOf(gh: Gh, top: PullRequest): Promise<Target> {
  const layers: Layer[] = [layerOf(top)];
  const seen = new Set([top.branch]);

  for (let lowest = top; lowest.base !== DEV;) {
    const under = await openWithHead(gh, lowest.base);

    if (under.length === 0) {
      return refused(
        `#${lowest.number} is based on ${lowest.base}, which has no open pull request: gh pr edit ${lowest.number} --base ${DEV} once ${lowest.base} is on ${DEV}, or open one`,
      );
    }

    const [only, ...others] = under;

    if (only === undefined || others.length > 0) {
      return refused(
        `${lowest.base}, the base of #${lowest.number}, heads ${under.length} open pull requests (${under.map((pr) => `#${pr.number}`).join(", ")}): close the extra ones, then land again`,
      );
    }

    if (seen.has(only.branch))
      return refused(`the bases of #${top.number} loop back to ${only.branch}`);

    seen.add(only.branch);
    layers.unshift(layerOf(only));
    lowest = only;
  }

  return { kind: "layers", layers, stack: null };
}

/** What `n` lands: the pull request `n` and those under it, or the open layers of stack `n`. */
export async function resolveTarget(gh: Gh, n: number): Promise<Target> {
  const [pr, stack] = await Promise.all([pullRequestOf(gh, n), stackOf(gh, n)]);

  if (pr !== null && stack !== null) return refused(`#${n} is both a pull request and a stack`);

  if (stack !== null && stack.length > 0) {
    const layers = stack.map((layer) => layerOf(layer));
    const broken = chainRefusal(layers);

    return broken === null
      ? { kind: "layers", layers, stack: n }
      : refused(`stack #${n} does not read as one chain: ${broken}`);
  }

  if (pr === null)
    return refused(`#${n} is neither an open pull request nor a stack with open pull requests`);

  if (pr.state !== "OPEN") return refused(`#${n} is ${pr.state.toLowerCase()}, not open`);

  return chainOf(gh, pr);
}
