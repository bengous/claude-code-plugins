#!/usr/bin/env bun

/**
 * PreToolUse on ExitPlanMode: denies a plan that `plan-lint.ts` finds fault
 * with, the findings as the reason Claude reads. Plan mode answers a denied
 * ExitPlanMode with another call, so each plan is denied once: the digest of
 * the last plan denied is kept per session and agent, and that same plan,
 * submitted again, goes on to the user's approval in silence. The user has the
 * findings already: the transcript shows the denial just above the plan dialog,
 * which renders neither a `systemMessage` nor an `ask` reason (CLI 2.1.301).
 * A finding Claude judges wrong costs one resubmission, never a loop. Any
 * failure lets the plan through: the gate never holds a session in plan mode.
 */

import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { parsePayload, planText, SAFE_ID, stripSessionLine } from "./plan-comment.ts";
import type { Finding } from "./plan-lint.ts";
import { formatFindings, lintPlan } from "./plan-lint.ts";

export type Verdict = { kind: "pass" } | { kind: "waive" } | { kind: "deny"; reason: string };

/** The session line is left out: capture-plan.ts may add it to the plan file between two calls. */
export function planDigest(plan: string): string {
  return createHash("sha256").update(stripSessionLine(plan).trim()).digest("hex");
}

export function verdict(
  findings: readonly Finding[],
  digest: string,
  lastDenied: string | null,
): Verdict {
  if (findings.length === 0) return { kind: "pass" };

  if (digest === lastDenied) return { kind: "waive" };

  return {
    kind: "deny",
    reason: [
      `plan-lint refused the plan (${findings.length} finding${findings.length === 1 ? "" : "s"}):`,
      formatFindings(findings),
      "Revise the plan file, then call ExitPlanMode again. If a finding is wrong, call ExitPlanMode again with the plan unchanged: the same plan goes on to the user, who sees these findings above it.",
    ].join("\n"),
  };
}

/**
 * `~/.claude/plans/lint/<session>[/<agent>].sha256`, beside the by-session store
 * and as private as it, or null for an id that is no file name.
 */
export function lintStatePath(home: string, session: string, agent?: string): string | null {
  if (!SAFE_ID.test(session) || (agent !== undefined && !SAFE_ID.test(agent))) return null;
  const dir = join(home, ".claude", "plans", "lint");

  return agent === undefined
    ? join(dir, `${session}.sha256`)
    : join(dir, session, `${agent}.sha256`);
}

if (import.meta.main) {
  try {
    const payload = parsePayload(await Bun.stdin.text());
    const plan = payload === null ? null : planText(payload);
    const session = payload?.session_id;

    if (plan === null || session === undefined) process.exit(0);

    const state = lintStatePath(homedir(), session, payload?.agent_id);

    if (state === null) process.exit(0);

    const stored = Bun.file(state);
    const lastDenied = (await stored.exists()) ? await stored.text() : null;
    const digest = planDigest(plan);
    const result = verdict(lintPlan(plan), digest, lastDenied);

    if (result.kind === "pass") {
      await rm(state, { force: true });
    } else if (result.kind === "deny") {
      await mkdir(dirname(state), { recursive: true });
      await Bun.write(state, digest);
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: result.reason,
          },
        }),
      );
    }
  } catch (error) {
    console.error(`gate-plan: ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(0);
}
