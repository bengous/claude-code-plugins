#!/usr/bin/env bun

/**
 * The pre-push hook's check of the landing lock (`landing-lock.ts`): a push that moves `dev` waits for the landing
 * that holds it, unless it is that landing's own push. Run with no URL, as the hook is outside a push, it checks
 * nothing.
 *
 *   bun ./scripts/landing/lock-check.ts <url> < <git's pushed-ref lines>
 */

import { messageOf } from "../../tools/platform/pure.ts";
import { HOLDER_ENV, pushRefusal } from "./landing-lock.ts";

if (import.meta.main) {
  const [url, ...rest] = process.argv.slice(2);

  if (url === undefined || rest.length > 0) {
    console.error("Usage: bun ./scripts/landing/lock-check.ts <url> < <pushed-ref lines>");
    process.exit(2);
  }

  try {
    const refusal =
      url === "" ? null : pushRefusal(await Bun.stdin.text(), url, process.env[HOLDER_ENV]);

    if (refusal !== null) {
      console.error(`pre-push: ${refusal}`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`lock-check: ${messageOf(error)}`);
    process.exitCode = 1;
  }
}
