#!/usr/bin/env bun

/**
 * PreToolUse on Write: the session line goes into the harness's plan file
 * through updatedInput, as the plan is written. Tagging the file after the
 * write instead changes it under the agent, which Claude Code then reports to
 * the agent as a file changed on disk.
 */

import { homedir } from "node:os";

import { parsePayload, stampedPlanWrite } from "./plan-comment.ts";

if (import.meta.main) {
  try {
    const payload = parsePayload(await Bun.stdin.text());

    if (payload === null) process.exit(0);
    const updatedInput = stampedPlanWrite(payload, homedir());

    if (updatedInput !== null) {
      console.log(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } }),
      );
    }
  } catch (error) {
    console.error(`stamp-plan: ${error instanceof Error ? error.message : String(error)}`);
  }

  process.exit(0);
}
