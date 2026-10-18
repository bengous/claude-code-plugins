import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HookPayload } from "./plan-comment.ts";
import {
  buildBody,
  carriedPlan,
  findPlanComment,
  harnessPlanFile,
  isPrCreate,
  parsePayload,
  PLAN_MARKER,
  planPath,
  planText,
  prFrom,
  sessionMarkers,
  stampedPlanWrite,
  withSessionLine,
} from "./plan-comment.ts";

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function makeTmp(): string {
  const tmp = mkdtempSync(join(tmpdir(), "plan-comment-"));
  tmpDirs.push(tmp);

  return tmp;
}

describe("parsePayload", () => {
  test("reads the fields the hooks use", () => {
    const payload = parsePayload(
      JSON.stringify({
        cwd: "/repo",
        session_id: "abc123",
        tool_input: { command: "gh pr create", plan: "# Plan" },
        tool_response: { plan: "# Approved" },
      }),
    );

    expect(payload?.cwd).toBe("/repo");
    expect(payload?.session_id).toBe("abc123");
    expect(payload?.tool_input?.command).toBe("gh pr create");
    expect(payload?.tool_response?.plan).toBe("# Approved");
  });

  test("malformed JSON yields null", () => {
    expect(parsePayload("")).toBeNull();
    expect(parsePayload("{oops")).toBeNull();
  });
});

describe("planText", () => {
  test("PreToolUse carries the plan in tool_input", () => {
    expect(planText({ tool_input: { plan: "# Plan\n1. Do it" } })).toBe("# Plan\n1. Do it");
  });

  test("a PostToolUse response wins over the input", () => {
    expect(planText({ tool_input: { plan: "draft" }, tool_response: { plan: "approved" } })).toBe(
      "approved",
    );
  });

  test("no plan, or a blank one, yields null", () => {
    expect(planText({})).toBeNull();
    expect(planText({ tool_input: {} })).toBeNull();
    expect(planText({ tool_input: { plan: "  \n " } })).toBeNull();
  });
});

describe("isPrCreate", () => {
  test("matches the command whatever wraps it", () => {
    expect(isPrCreate("gh pr create --base dev")).toBe(true);
    expect(isPrCreate("cd /repo && gh  pr\tcreate --fill")).toBe(true);
  });

  test("ignores every other gh call", () => {
    expect(isPrCreate("")).toBe(false);
    expect(isPrCreate("gh pr view --json number")).toBe(false);
    expect(isPrCreate("gh pr comment 12 --body x")).toBe(false);
    expect(isPrCreate("gh issue create")).toBe(false);
  });
});

describe("prFrom", () => {
  test("takes the repository and number of the first pull URL", () => {
    expect(prFrom('{"stdout":"https://github.com/o/r/pull/42\\n"}')).toEqual({
      repo: "o/r",
      number: 42,
    });
    expect(prFrom("https://github.com/o/r/pull/7 https://github.com/x/y/pull/9")).toEqual({
      repo: "o/r",
      number: 7,
    });
  });

  test("an enterprise host names its repository the same way", () => {
    expect(prFrom("https://ghe.example.com/team/app/pull/3")).toEqual({
      repo: "team/app",
      number: 3,
    });
  });

  test("no URL yields null", () => {
    expect(prFrom("")).toBeNull();
    expect(prFrom("https://github.com/o/r/issues/42")).toBeNull();
    expect(prFrom("/pull/42")).toBeNull();
  });
});

describe("planPath", () => {
  test("keys the session, and nests a subagent under it", () => {
    expect(planPath("/h", "abc")).toBe("/h/.claude/plans/by-session/abc.md");
    expect(planPath("/h", "abc", "agent-7f")).toBe("/h/.claude/plans/by-session/abc/agent-7f.md");
  });

  test("an id that is not a safe path segment yields null", () => {
    expect(planPath("/h", "")).toBeNull();
    expect(planPath("/h", "..")).toBeNull();
    expect(planPath("/h", "a/b")).toBeNull();
    expect(planPath("/h", "abc", "..")).toBeNull();
  });
});

describe("sessionMarkers", () => {
  test("names every session, in order, once each", () => {
    expect(sessionMarkers("<!-- session_id: A -->\nx\n<!-- session_id: B -->\n")).toEqual([
      "A",
      "B",
    ]);
    expect(sessionMarkers("<!-- session_id: A -->\n<!-- session_id: A -->")).toEqual(["A"]);
  });

  test("no marker yields nothing", () => {
    expect(sessionMarkers("")).toEqual([]);
    expect(sessionMarkers("# Plan\n1. Do it")).toEqual([]);
  });

  test("the pr skill's body lines are not plan markers", () => {
    expect(sessionMarkers("<!-- opened_by: A -->\n<!-- updated_by: B -->")).toEqual([]);
  });

  test("finds a marker inside a JSON-escaped transcript line", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "<!-- session_id: A -->\n# Plan" },
    });

    expect(sessionMarkers(line)).toEqual(["A"]);
  });
});

/** A home with the stored plans given, and a transcript of one line per content. */
async function makeTranscript(
  stored: Record<string, string>,
  lines: string[],
): Promise<{ home: string; transcript: string }> {
  const tmp = makeTmp();
  const home = join(tmp, "home");

  for (const [id, text] of Object.entries(stored)) {
    await Bun.write(join(home, ".claude", "plans", "by-session", `${id}.md`), text);
  }

  const transcript = join(tmp, "t.jsonl");
  await Bun.write(
    transcript,
    lines
      .map((content) => JSON.stringify({ type: "user", message: { role: "user", content } }))
      .join("\n"),
  );

  return { home, transcript };
}

describe("carriedPlan", () => {
  test("a marker with a stored plan yields that plan", async () => {
    const { home, transcript } = await makeTranscript({ A: "<!-- session_id: A -->\n# Plan\n" }, [
      "go",
      "<!-- session_id: A -->\n# Plan",
      "done",
    ]);

    expect(await carriedPlan(home, transcript)).toBe("<!-- session_id: A -->\n# Plan\n");
  });

  test("the last marker that has a file wins", async () => {
    const { home, transcript } = await makeTranscript({ A: "# A's plan\n" }, [
      "<!-- session_id: A -->",
      "quoting <!-- session_id: B --> here",
    ]);

    expect(await carriedPlan(home, transcript)).toBe("# A's plan\n");
  });

  test("a marker with no stored plan yields null", async () => {
    const { home, transcript } = await makeTranscript({}, ["<!-- session_id: A -->"]);

    expect(await carriedPlan(home, transcript)).toBeNull();
  });

  test("a plan comment read from GitHub does not count", async () => {
    const { home, transcript } = await makeTranscript({ X: "# X's plan\n" }, [
      `${PLAN_MARKER}\n<!-- session_id: X -->\n<details><summary>Plan</summary>`,
      `${PLAN_MARKER}\r\n<!-- session_id: X -->\r\n<details>`,
    ]);

    expect(await carriedPlan(home, transcript)).toBeNull();
  });

  test("an injected plan still wins over a later quoted comment", async () => {
    const { home, transcript } = await makeTranscript({ A: "# A's plan\n", X: "# X's plan\n" }, [
      "<!-- session_id: A -->\n# Plan",
      `${PLAN_MARKER}\n<!-- session_id: X -->`,
    ]);

    expect(await carriedPlan(home, transcript)).toBe("# A's plan\n");
  });

  test("no marker yields null", async () => {
    const { home, transcript } = await makeTranscript({ A: "# A's plan\n" }, ["go"]);

    expect(await carriedPlan(home, transcript)).toBeNull();
  });

  test("a transcript that does not exist yields null", async () => {
    const { home } = await makeTranscript({ A: "# A's plan\n" }, ["<!-- session_id: A -->"]);

    expect(await carriedPlan(home, join(home, "nowhere.jsonl"))).toBeNull();
  });
});

/** A home whose `~/.claude/plans/<name>.md` files hold the given content. */
async function makeHome(files: Record<string, string>): Promise<string> {
  const home = join(makeTmp(), "home");

  for (const [name, text] of Object.entries(files)) {
    await Bun.write(join(home, ".claude", "plans", name), text);
  }

  return home;
}

describe("harnessPlanFile", () => {
  test("the newest file with the same content wins", async () => {
    const home = await makeHome({ "old.md": "# Plan\n", "new.md": "# Plan\n" });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(join(home, ".claude", "plans", "old.md"), old, old);

    expect(await harnessPlanFile(home, "# Plan")).toBe(join(home, ".claude", "plans", "new.md"));
  });

  test("a file already tagged still matches the untagged plan", async () => {
    const home = await makeHome({ "a.md": "<!-- session_id: A -->\n# Plan\n" });

    expect(await harnessPlanFile(home, "# Plan")).toBe(join(home, ".claude", "plans", "a.md"));
  });

  test("a plan written hours before its approval is still found", async () => {
    const home = await makeHome({ "a.md": "# Plan\n" });
    const earlier = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(home, ".claude", "plans", "a.md"), earlier, earlier);

    expect(await harnessPlanFile(home, "# Plan")).toBe(join(home, ".claude", "plans", "a.md"));
  });

  test("subdirectories are skipped, not descended", async () => {
    const home = await makeHome({ "by-session/A.md": "# Plan\n" });

    expect(await harnessPlanFile(home, "# Plan")).toBeNull();
  });

  test("no matching content, or no plans directory, yields null", async () => {
    const home = await makeHome({ "a.md": "# Other\n" });

    expect(await harnessPlanFile(home, "# Plan")).toBeNull();
    expect(await harnessPlanFile(join(home, "nowhere"), "# Plan")).toBeNull();
  });
});

describe("withSessionLine", () => {
  test("the session line opens the file, the plan follows", () => {
    expect(withSessionLine("# Plan", "abc123")).toBe("<!-- session_id: abc123 -->\n# Plan\n");
    expect(withSessionLine("# Plan\n", "abc123")).toBe("<!-- session_id: abc123 -->\n# Plan\n");
  });

  test("no session id writes the plan alone, with no empty marker", () => {
    expect(withSessionLine("# Plan", undefined)).toBe("# Plan\n");
    expect(withSessionLine("# Plan", "")).toBe("# Plan\n");
  });

  test("re-tagging replaces the line instead of stacking one", () => {
    expect(withSessionLine(withSessionLine("# Plan", "A"), "B")).toBe(
      "<!-- session_id: B -->\n# Plan\n",
    );
  });
});

/** The payload of a Write of `content` to `file_path` in session `session_id`. */
function planWrite(file_path: string, content: string, session_id?: string): HookPayload {
  return session_id === undefined
    ? { tool_input: { file_path, content } }
    : { session_id, tool_input: { file_path, content } };
}

describe("stampedPlanWrite", () => {
  const plan = "/h/.claude/plans/slug.md";

  test("a Write of a plan file gets the session line", () => {
    expect(stampedPlanWrite(planWrite(plan, "# Plan\n", "A"), "/h")).toEqual({
      file_path: plan,
      content: "<!-- session_id: A -->\n# Plan\n",
    });
  });

  test("a plan already stamped by this session is left alone", () => {
    const stamped = "<!-- session_id: A -->\n# Plan\n";

    expect(stampedPlanWrite(planWrite(plan, stamped, "A"), "/h")).toBeNull();
  });

  test("a plan stamped by another session is stamped again with this one", () => {
    const other = "<!-- session_id: B -->\n# Plan\n";

    expect(stampedPlanWrite(planWrite(plan, other, "A"), "/h")?.content).toBe(
      "<!-- session_id: A -->\n# Plan\n",
    );
  });

  test("a Write outside the plans directory, or below it, is left alone", () => {
    for (const file of [
      "/h/.claude/plans/by-session/A.md",
      "/h/notes/slug.md",
      "/h/.claude/plans/slug.txt",
    ]) {
      expect(stampedPlanWrite(planWrite(file, "# Plan\n", "A"), "/h")).toBeNull();
    }
  });

  test("a missing session id, or one that is not a safe path segment, is left alone", () => {
    expect(stampedPlanWrite(planWrite(plan, "# Plan\n", "a b"), "/h")).toBeNull();
    expect(stampedPlanWrite(planWrite(plan, "# Plan\n"), "/h")).toBeNull();
  });
});

describe("buildBody", () => {
  test("marker first, plan inside a details block", () => {
    expect(buildBody("# Plan\n1. Do it\n")).toBe(
      `${PLAN_MARKER}\n<details><summary>Plan</summary>\n\n# Plan\n1. Do it\n\n</details>\n`,
    );
  });

  test("a session line is hoisted next to the marker, out of the details block", () => {
    expect(buildBody(withSessionLine("# Plan", "abc123"))).toBe(
      `${PLAN_MARKER}\n<!-- session_id: abc123 -->\n<details><summary>Plan</summary>\n\n# Plan\n\n</details>\n`,
    );
  });

  test("a hoisted session line still opens a matching plan comment", () => {
    const body = buildBody(withSessionLine("# Plan", "abc123"));
    expect(findPlanComment(JSON.stringify({ id: 5, login: "me", body }), "me")).toBe(5);
  });

  test("its own output is recognised as a plan comment", () => {
    const body = buildBody("# Plan");
    expect(findPlanComment(JSON.stringify({ id: 1, login: "me", body }), "me")).toBe(1);
  });

  test("another executing session follows the session line", () => {
    expect(buildBody(withSessionLine("# Plan", "A"), "B")).toBe(
      `${PLAN_MARKER}\n<!-- session_id: A -->\n<!-- executed_by: B -->\n<details><summary>Plan</summary>\n\n# Plan\n\n</details>\n`,
    );
  });

  test("the session that wrote the plan is not named twice", () => {
    expect(buildBody(withSessionLine("# Plan", "A"), "A")).toBe(
      `${PLAN_MARKER}\n<!-- session_id: A -->\n<details><summary>Plan</summary>\n\n# Plan\n\n</details>\n`,
    );
  });

  test("an untagged plan carries the executing session alone", () => {
    expect(buildBody("# Plan", "B")).toBe(
      `${PLAN_MARKER}\n<!-- executed_by: B -->\n<details><summary>Plan</summary>\n\n# Plan\n\n</details>\n`,
    );
  });

  test("a two-line header still opens a matching plan comment", () => {
    const body = buildBody(withSessionLine("# Plan", "A"), "B");
    expect(findPlanComment(JSON.stringify({ id: 6, login: "me", body }), "me")).toBe(6);
  });
});

describe("findPlanComment", () => {
  const lines = [
    JSON.stringify({ id: 1, login: "me", body: "LGTM" }),
    JSON.stringify({ id: 2, login: "other", body: `${PLAN_MARKER}\nsomeone else's` }),
    JSON.stringify({ id: 3, login: "me", body: `${PLAN_MARKER}\nmine` }),
    "",
  ].join("\n");

  test("takes the caller's own marked comment", () => {
    expect(findPlanComment(lines, "me")).toBe(3);
  });

  test("no marked comment of ours yields null", () => {
    expect(findPlanComment(lines, "nobody")).toBeNull();
    expect(findPlanComment("", "me")).toBeNull();
  });

  test("the marker must open the body", () => {
    const late = JSON.stringify({ id: 4, login: "me", body: `text\n${PLAN_MARKER}` });
    expect(findPlanComment(late, "me")).toBeNull();
  });
});
