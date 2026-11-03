import type { Harness, HookKind } from "./hook.ts";
import type { Verdict } from "./verdict.ts";

/** The event name a hook's `hookSpecificOutput` carries, under Claude Code and Codex alike. */
const HOOK_EVENTS: Readonly<Record<HookKind, string>> = {
  "session-start": "SessionStart",
  "pre-edit": "PreToolUse",
  "post-edit": "PostToolUse",
  stop: "Stop",
  "pre-bash": "PreToolUse",
  "user-prompt-expansion": "UserPromptExpansion",
};

/** The wire shape of a verdict. Key order is part of the contract: the tests pin the bytes. */
export function encode(verdict: Verdict, harness: Harness, hook: HookKind): string | null {
  switch (verdict.kind) {
    case "allow": {
      return harness === "codex" && hook === "stop" ? JSON.stringify({ continue: true }) : null;
    }

    case "note": {
      return harness === "codex" && hook === "stop"
        ? JSON.stringify({ continue: true, systemMessage: verdict.text })
        : JSON.stringify({ systemMessage: verdict.text });
    }

    case "context": {
      const hookSpecificOutput = {
        hookEventName: HOOK_EVENTS[hook],
        additionalContext: verdict.text,
      };

      // The pull requests UserPromptExpansion labels carry the human's ok: the human sees which, not only the agent.
      return JSON.stringify(
        hook === "user-prompt-expansion"
          ? { hookSpecificOutput, systemMessage: verdict.text }
          : { hookSpecificOutput },
      );
    }

    case "block": {
      return JSON.stringify({ decision: "block", reason: verdict.reason });
    }

    case "deny": {
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      });
    }

    case "rewrite": {
      if (harness !== "claude" || hook !== "pre-edit") {
        return null;
      }

      return JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: verdict.updatedInput },
        systemMessage: verdict.text,
      });
    }

    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}
