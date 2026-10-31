#!/usr/bin/env bun

/** Runs on every Bash call, so the command check comes before any subprocess. */

import { homedir } from "node:os";

import { messageOf } from "../lib/platform/pure.ts";
import {
  carriedPlan,
  isPrCreate,
  parsePayload,
  planPath,
  prFrom,
  upsertPlanComment,
} from "./plan-comment.ts";

if (import.meta.main) {
  try {
    const payload = parsePayload(await Bun.stdin.text());

    if (payload === null) process.exit(0);

    if (!isPrCreate(payload.tool_input?.command ?? "")) process.exit(0);

    const pr = prFrom(JSON.stringify(payload.tool_response ?? ""));

    if (pr === null) process.exit(0);

    const cwd = payload.cwd ?? process.cwd();
    const home = homedir();
    const own = planPath(home, payload.session_id ?? "", payload.agent_id);
    const plan = own === null ? null : Bun.file(own);

    if (plan !== null && (await plan.exists())) {
      await upsertPlanComment(cwd, pr, await plan.text());
      process.exit(0);
    }

    // No plan of its own: this session may have received one through "fresh context".
    const transcript = payload.transcript_path;

    if (transcript === undefined) process.exit(0);
    const carried = await carriedPlan(home, transcript);

    if (carried === null) process.exit(0);

    await upsertPlanComment(cwd, pr, carried, payload.session_id);
  } catch (error) {
    console.error(`attach-plan: ${messageOf(error)}`);
  }

  process.exit(0);
}
