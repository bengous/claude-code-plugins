import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomicSync } from "../lib/platform/fs.ts";
import { run } from "../lib/platform/process.ts";
import { TEMPLATES_DIR } from "./templates.ts";

const HOOK = join(TEMPLATES_DIR, "repo", ".claude", "hooks", "pr-body.ts");

const CHECK = ".claude/skills/pr/scripts/check-pr.ts";

/** A stand-in for the pr skill's check: refuses a body that holds "Left open", exits 2 on "unreadable". */
const FAKE_CHECK = `const body = await new Response(Bun.stdin.stream()).text();
if (process.argv[2] !== "-") { console.error("expected -"); process.exit(2); }
if (body.includes("unreadable")) { console.error("bad settings"); process.exit(2); }
const at = body.split("\\n").findIndex((line) => line.includes("Left open"));
if (at >= 0) { console.log(\`-:\${at + 1}: open-point: a body leaves nothing open\`); process.exit(1); }
`;

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "factory-pr-body-"));
  writeAtomicSync(join(repo, CHECK), FAKE_CHECK, { mkdir: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function input(toolInput: Readonly<Record<string, string>>): string {
  return JSON.stringify({ tool_name: "mcp__github__create_pull_request", tool_input: toolInput });
}

async function hook(stdin: string): Promise<{ code: number; stderr: string }> {
  const result = await run([process.execPath, HOOK], {
    cwd: repo,
    env: { CLAUDE_PROJECT_DIR: repo },
    stdin,
  });

  if (result.kind !== "exited") throw new Error(`the hook did not exit: ${JSON.stringify(result)}`);

  return { code: result.code, stderr: result.stderr.trim() };
}

describe("the pull request body hook", () => {
  test("lets a body the check passes through", async () => {
    expect(await hook(input({ title: "t", body: "Closes #1.\n\nWhy: it broke." }))).toEqual({
      code: 0,
      stderr: "",
    });
  });

  test("refuses a body the check refuses, with the check's line", async () => {
    const { code, stderr } = await hook(input({ body: "Closes #1.\n\n## Left open\n- x" }));

    expect(code).toBe(2);
    expect(stderr).toContain("-:3: open-point: a body leaves nothing open");
    expect(stderr).toContain("Rewrite it with the pr skill");
  });

  test("refuses the call when the check cannot judge the body", async () => {
    const { code, stderr } = await hook(input({ body: "unreadable" }));

    expect(code).toBe(2);
    expect(stderr).toContain("could not judge the body (exit 2)");
    expect(stderr).toContain("bad settings");
  });

  test("lets through a call that writes no body", async () => {
    expect((await hook(input({ title: "only the title" }))).code).toBe(0);
  });

  test("lets through an input that does not read", async () => {
    expect((await hook("not json")).code).toBe(0);
  });

  test("lets through a repository without the check", async () => {
    rmSync(join(repo, ".claude"), { recursive: true });

    expect((await hook(input({ body: "## Left open" }))).code).toBe(0);
  });
});
