#!/usr/bin/env bun

/* oxlint-disable anti-slop/no-runtime-typeof -- this hook IS the boundary parser that rule asks for: it is installed alone in another repository, and narrows here the hook input Claude Code sends on stdin. */

/**
 * PreToolUse hook on the GitHub tools that write a pull request's body: runs the body through the
 * `pr` skill's check, and refuses the call while the check has a finding.
 *
 * Reads the hook's input on stdin. A call that writes no body, or a repository without the check,
 * passes. Exit 0 lets the call through; exit 2 refuses it, the check's findings on stderr, which
 * Claude reads.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const CHECK = ".claude/skills/pr/scripts/check-pr.ts";

type Verdict = { readonly code: 0 } | { readonly code: 2; readonly message: string };

/** The body the call writes, or `null` when it writes none or the input does not read. */
export function bodyOf(input: string): string | null {
  try {
    const parsed: unknown = JSON.parse(input);

    if (parsed === null || typeof parsed !== "object" || !("tool_input" in parsed)) return null;
    const toolInput: unknown = parsed.tool_input;

    if (toolInput === null || typeof toolInput !== "object" || !("body" in toolInput)) return null;

    return typeof toolInput.body === "string" ? toolInput.body : null;
  } catch {
    return null;
  }
}

/** What the check's exit says of the body: 0 passes it, any other code refuses the call. */
export function verdictOf(code: number | null, stdout: string, stderr: string): Verdict {
  if (code === 0) return { code: 0 };

  const said = [stdout.trim(), stderr.trim()].filter((text) => text !== "").join("\n");

  return {
    code: 2,
    message:
      code === 1
        ? `The pull request body breaks the shape of the pr skill:\n${said}\nRewrite it with the pr skill, then call again.`
        : `The pr skill's check could not judge the body (exit ${code ?? "killed"}):\n${said}`,
  };
}

async function main(): Promise<number> {
  const body = bodyOf(await new Response(Bun.stdin.stream()).text());
  const root = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  const check = join(root, CHECK);

  if (body === null || !existsSync(check)) return 0;

  const child = Bun.spawn([process.execPath, check, "-"], {
    cwd: root,
    stdin: new TextEncoder().encode(body),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const verdict = verdictOf(child.signalCode === null ? code : null, stdout, stderr);

  if (verdict.code === 2) console.error(verdict.message);

  return verdict.code;
}

if (import.meta.main) process.exit(await main());
