/**
 * Captures a plan as ExitPlanMode is called. `gate-plan.ts`, the one hook on
 * that call, runs it once the lint lets the plan through, so a plan the lint
 * denies is never stored nor posted.
 *
 * PreToolUse, not PostToolUse: the plan dialog's "Yes, clear context" options
 * resolve ExitPlanMode as a denial (CLI 2.1.270), and PostToolUse only runs
 * after a tool succeeds, so a plan approved that way would never be captured.
 * The cost is a file written for a plan the user then rejects, overwritten by
 * the next approval in that session.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { HookPayload } from "./plan-comment.ts";
import {
  harnessPlanFile,
  openPr,
  planPath,
  upsertPlanComment,
  withSessionLine,
} from "./plan-comment.ts";

export async function capturePlan(payload: HookPayload, plan: string, home: string): Promise<void> {
  const session = payload.session_id;

  if (session === undefined) return;
  const file = planPath(home, session, payload.agent_id);

  if (file === null) return;

  const content = withSessionLine(plan, session);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, content);

  // The harness re-injects its own copy into a fresh-context session; tagging it
  // is what carries the planning session's id across that handoff. stamp-plan.ts
  // tags it as it is written, so this write only catches a plan written without it.
  const harness = await harnessPlanFile(home, plan);

  if (harness !== null && (await Bun.file(harness).text()) !== content) {
    await Bun.write(harness, content);
  }

  const cwd = payload.cwd ?? process.cwd();
  const pr = await openPr(cwd);

  if (pr !== null) await upsertPlanComment(cwd, pr, content);
}
