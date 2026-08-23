#!/usr/bin/env bun

/**
 * PreToolUse hook for Bash — enforces the repo's push policy on `git push`.
 * Receives Claude Code tool JSON on stdin.
 *
 * The GitHub rulesets accept two pushes that are policy violations here:
 * a fast-forward push to `main` (the release, reserved to the human) and a
 * linear-history force push to `dev` (rewrites the shared trunk every local
 * `dev` caches). Only prose forbade them; this hook refuses them.
 *
 * @usage
 * In .claude/settings.json:
 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{
 *         "type": "command",
 *         "command": "bun .claude/hooks/guard-git-push.ts",
 *         "timeout": 5
 *       }]
 *     }]
 *   }
 * }
 * ```
 */

import { HOOK_EXIT, parseHookInput, stripStringLiterals } from "./guard-destructive.ts";
import { extractCdTarget, getCurrentBranch, getRepoRoot } from "./guard-main-branch.ts";

export interface PushTarget {
  readonly ref: string;
  readonly forced: boolean;
}

export type PushCommand =
  | { readonly kind: "not-push" }
  | {
      readonly kind: "push";
      readonly force: boolean;
      readonly targets: ReadonlyArray<PushTarget>;
    };

export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

const SEGMENT_SEPARATORS = /&&|\|\||[;|\n]/u;
const PUSH_SEGMENT = /\bgit\s+push\b(.*)/u;
const LONG_FORCE_FLAGS = /^(?:--force|--force-with-lease(?:=\S*)?|--force-if-includes)$/u;
const SHORT_FLAG_CLUSTER_WITH_F = /^-[A-Za-z]*f[A-Za-z]*$/u;
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
]);

function normalizeRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function destinationOf(refspec: string): string {
  const colon = refspec.indexOf(":");
  return normalizeRef(colon === -1 ? refspec : refspec.slice(colon + 1));
}

export function parsePush(cmd: string): PushCommand {
  let sawPush = false;
  let force = false;
  const targets: PushTarget[] = [];

  for (const segment of stripStringLiterals(cmd).split(SEGMENT_SEPARATORS)) {
    const match = segment.match(PUSH_SEGMENT);
    const tail = match?.[1];
    if (tail === undefined) continue;
    sawPush = true;

    let segmentForce = false;
    const positionals: string[] = [];
    let skipNext = false;
    for (const token of tail.trim().split(/\s+/u)) {
      if (token.length === 0) continue;
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (token.startsWith("-")) {
        if (LONG_FORCE_FLAGS.test(token) || SHORT_FLAG_CLUSTER_WITH_F.test(token)) {
          segmentForce = true;
        }
        if (VALUE_FLAGS.has(token)) skipNext = true;
        continue;
      }
      positionals.push(token);
    }

    for (const refspec of positionals.slice(1)) {
      const plus = refspec.startsWith("+");
      const ref = destinationOf(plus ? refspec.slice(1) : refspec);
      if (ref.length === 0) continue;
      targets.push({ ref, forced: segmentForce || plus });
    }
    force = force || segmentForce;
  }

  return sawPush ? { kind: "push", force, targets } : { kind: "not-push" };
}

export function decide(push: PushCommand, currentBranch: string | null): Verdict {
  switch (push.kind) {
    case "not-push":
      return { kind: "allow" };
    case "push": {
      const targets =
        push.targets.length > 0
          ? push.targets
          : currentBranch === null
            ? []
            : [{ ref: currentBranch, forced: push.force }];
      for (const target of targets) {
        if (target.ref === "main") {
          return {
            kind: "deny",
            reason:
              "pushing to 'main' is the human's release step (git push origin dev:main). " +
              "Agents land on 'dev'; procedures: docs/repo-ops.md.",
          };
        }
        if (target.ref === "dev" && target.forced) {
          return {
            kind: "deny",
            reason:
              "force pushes never target 'dev': every local dev is a cache of the shared trunk. " +
              "Land with `git fetch origin && git rebase origin/dev && git push origin <branch>:dev`; " +
              "procedures: docs/repo-ops.md.",
          };
        }
      }
      return { kind: "allow" };
    }
    default: {
      const unreachable: never = push;
      throw new Error(`unhandled push command: ${JSON.stringify(unreachable)}`);
    }
  }
}

if (import.meta.main) {
  if (process.env["MAIN_BYPASS"] === "1") process.exit(HOOK_EXIT.ALLOW);

  const input = await Bun.stdin.text();
  const cmd = parseHookInput(input);
  if (!cmd) process.exit(HOOK_EXIT.ALLOW);

  const push = parsePush(cmd);
  if (push.kind === "not-push") process.exit(HOOK_EXIT.ALLOW);

  const cdTarget = extractCdTarget(cmd);
  if (cdTarget) {
    const targetRoot = getRepoRoot(cdTarget);
    const projectRoot = getRepoRoot(process.env["CLAUDE_PROJECT_DIR"]);
    if (targetRoot && projectRoot && targetRoot !== projectRoot) {
      process.exit(HOOK_EXIT.ALLOW);
    }
  }

  const verdict = decide(push, getCurrentBranch(cdTarget ?? undefined));
  if (verdict.kind === "deny") {
    console.error(`BLOCKED: ${verdict.reason}`);
    process.exit(HOOK_EXIT.BLOCK);
  }
}
