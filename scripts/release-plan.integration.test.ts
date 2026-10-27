import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parseChangelog, type Semver } from "./changelog.ts";
import {
  type CommitId,
  commitAt,
  type MarketplaceName,
  type SourceDir,
} from "./check-plugin-bumps.ts";
import { type PluginDir, pluginDirAt } from "./lib/plugin-sources.ts";
import {
  bumped,
  changesOf,
  claudeArgs,
  judgementOf,
  loadPlan,
  localDate,
  type PluginChange,
  promptOf,
  proposedLevel,
  type ReleasePlan,
  schemaOf,
  sealPlan,
  withSection,
  withVersion,
} from "./release-plan.ts";

function semver(text: string): Semver {
  // SAFETY: the brand states x.y.z; every literal passed here is one.
  return text as Semver;
}

interface Answer {
  readonly level?: string;
  readonly reason?: string;
  readonly summary?: string;
  readonly body?: string | undefined;
}

interface ResultFields {
  readonly structured_output?: Answer;
  readonly total_cost_usd?: number;
  readonly result?: string;
}

function resultLine(fields: ResultFields): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

const ANSWER = {
  level: "minor",
  reason: "a new capability",
  summary: "a zone comes with its image",
  body: "### Added\n\n- A zone comes with its image.",
};

describe("proposedLevel, on subjects as git log printed them", () => {
  const breaking = "feat(pinpoint)!: nothing left to configure, the Vite plugin is gone";
  const feature = "feat(pinpoint): a zone comes with an image of it, as the page drew it";
  const fix = "fix(pinpoint): a long session name gives way in the layout, cut between graphemes";
  const chore = "chore(deps): update oxlint to v1.88.0 and pin every dependency (#352)";

  test("a `!` proposes major, a feat minor, anything else patch", () => {
    expect(proposedLevel([fix, breaking, feature], semver("1.4.0"))).toBe("major");
    expect(proposedLevel([fix, feature, chore], semver("1.4.0"))).toBe("minor");
    expect(proposedLevel([fix, chore, "docs(vellum): the 0.17.8 changelog"], semver("1.4.0"))).toBe(
      "patch",
    );
  });

  test("under 0.x, one step lower", () => {
    expect(proposedLevel([breaking], semver("0.17.9"))).toBe("minor");
    expect(proposedLevel([feature], semver("0.17.9"))).toBe("patch");
    expect(proposedLevel([fix], semver("0.17.9"))).toBe("patch");
  });

  test("a `!` or a feat counts only as the subject's type", () => {
    expect(proposedLevel(["fix(vellum): the feat! button"], semver("1.0.0"))).toBe("patch");
  });
});

describe("bumped", () => {
  test("raises one part and zeroes those after it", () => {
    expect(bumped(semver("0.17.9"), "patch")).toBe(semver("0.17.10"));
    expect(bumped(semver("0.17.9"), "minor")).toBe(semver("0.18.0"));
    expect(bumped(semver("0.17.9"), "major")).toBe(semver("1.0.0"));
    expect(bumped(semver("2.3.1"), "major")).toBe(semver("3.0.0"));
  });
});

describe("judgementOf", () => {
  test("reads the structured output of the last result message of an array", () => {
    const stdout = `[{"type":"system"},{"type":"result","subtype":"error_during_execution","is_error":true},${resultLine({ structured_output: ANSWER, total_cost_usd: 0.03 })}]`;

    expect(judgementOf(stdout, true)).toEqual({
      level: "minor",
      reason: "a new capability",
      summary: "a zone comes with its image",
      body: "### Added\n\n- A zone comes with its image.",
      costUsd: 0.03,
    });
  });

  test("reads a lone result message, and no body when none is asked", () => {
    expect(judgementOf(resultLine({ structured_output: ANSWER }), false)).toEqual({
      level: "minor",
      reason: "a new capability",
      summary: "a zone comes with its image",
      body: null,
      costUsd: null,
    });
  });

  test("keeps a reason on two lines", () => {
    const stdout = resultLine({ structured_output: { ...ANSWER, reason: "One.\nTwo." } });

    expect(judgementOf(stdout, true).reason).toBe("One.\nTwo.");
  });

  test.each([
    ["not JSON", "Error: --json-schema is not valid JSON", "printed no JSON"],
    ["no result", '[{"type":"system"}]', "no result message"],
    [
      "an error result",
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "x" }),
      "ended in error (error_max_turns)",
    ],
    ["no structured output", resultLine({ result: "{}" }), "without structured_output"],
    [
      "a level outside the three",
      resultLine({ structured_output: { ...ANSWER, level: "huge" } }),
      'level "huge" is not one of',
    ],
    [
      "an empty reason",
      resultLine({ structured_output: { ...ANSWER, reason: " " } }),
      '"reason" is missing or empty',
    ],
    [
      "a summary on two lines",
      resultLine({ structured_output: { ...ANSWER, summary: "one\ntwo" } }),
      '"summary" holds the control character U+000A',
    ],
    [
      "a carriage return that hides the start of the summary",
      resultLine({
        structured_output: { ...ANSWER, summary: "drops the telemetry\rsmall internal cleanup" },
      }),
      '"summary" holds the control character U+000D',
    ],
    [
      "an escape sequence in the reason",
      resultLine({ structured_output: { ...ANSWER, reason: "fine\u001B[8m hidden" } }),
      '"reason" holds the control character U+001B',
    ],
    [
      "an escape sequence in the body, where a line break is no control",
      resultLine({ structured_output: { ...ANSWER, body: "### Added\n\n- A.\u001B[8m hidden" } }),
      '"body" holds the control character U+001B',
    ],
    [
      "no body when one is asked",
      resultLine({ structured_output: { ...ANSWER, body: undefined } }),
      '"body" is missing or empty',
    ],
  ])("refuses %s", (_, stdout, why) => {
    expect(() => judgementOf(stdout, true)).toThrow(why);
  });
});

describe("the call to claude", () => {
  test("loads no tool, setting source, hook or MCP server, and asks for a body only of a plugin that keeps a changelog", () => {
    const args = claudeArgs(true);

    expect(args.slice(0, 6)).toEqual([
      "claude",
      "-p",
      "--model",
      "opus",
      "--output-format",
      "json",
    ]);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
    expect(schemaOf(true).required).toEqual(["level", "reason", "summary", "body"]);
    expect(schemaOf(false).required).toEqual(["level", "reason", "summary"]);
  });

  test("the prompt carries the commits, the diffstat, the proposed level and the last three sections", () => {
    const change: PluginChange = {
      // SAFETY: the brand states a catalog name; this one is a literal of the test.
      name: "vellum" as MarketplaceName,
      // SAFETY: the brand states a directory below the root; this one is a literal of the test.
      source: "vellum" as SourceDir,
      version: semver("0.17.9"),
      commits: [
        { subject: "fix(vellum): a pin", body: "The engine holds it." },
        { subject: "test(vellum): b", body: "" },
      ],
      diffstat: " vellum/a.ts | 2 +-",
      changelog: [
        "# Changelog",
        "",
        "## 0.17.9 - 2026-10-19",
        "",
        "Internal changes only: nine.",
        "",
        "## 0.17.8 - 2026-10-14",
        "",
        "Eight.",
        "",
        "## 0.17.7 - 2026-10-13",
        "",
        "Seven.",
        "",
        "## 0.17.6 - 2026-10-13",
        "",
        "Six.",
      ].join("\n"),
    };

    const prompt = promptOf(change, "patch");

    expect(prompt).toContain("Plugin: vellum\nCurrent version: 0.17.9\n");
    expect(prompt).toContain(
      "Level the commit subjects propose: patch (0.x: shifted down one step)",
    );
    expect(prompt).toContain(
      "<commits>\nfix(vellum): a pin\n\nThe engine holds it.\n\n---\n\ntest(vellum): b\n</commits>",
    );
    expect(prompt).toContain("<diffstat>\n vellum/a.ts | 2 +-\n</diffstat>");
    expect(prompt).toContain("## 0.17.7 - 2026-10-13\n\nSeven.\n</changelog_style_examples>");
    expect(prompt).not.toContain("Six.");
    expect(promptOf({ ...change, changelog: null }, "patch")).not.toContain("changelog_style");
  });
});

describe("the bump's files", () => {
  test("a section goes above the newest one, and the changelog still parses", () => {
    const changelog = "# Changelog\n\nIntro.\n\n## 0.1.0 - 2026-09-26\n\nFirst.\n";
    const next = withSection(changelog, "## 0.2.0 - 2026-10-20\n\n### Added\n\n- Two.");

    expect(next).toBe(
      "# Changelog\n\nIntro.\n\n## 0.2.0 - 2026-10-20\n\n### Added\n\n- Two.\n\n## 0.1.0 - 2026-09-26\n\nFirst.\n",
    );
    expect(parseChangelog(next).ok).toBe(true);
    expect(withSection("# Changelog\n", "## 0.1.0 - 2026-10-20\n\nFirst.")).toBe(
      "# Changelog\n\n## 0.1.0 - 2026-10-20\n\nFirst.\n",
    );
  });

  test("the manifest's one version field changes, nothing else of its text", () => {
    const manifest = '{\n  "name": "vellum",\n  "version": "0.17.9",\n  "keywords": ["a"]\n}\n';

    expect(withVersion(manifest, semver("0.17.9"), semver("0.17.10"), "m")).toBe(
      '{\n  "name": "vellum",\n  "version": "0.17.10",\n  "keywords": ["a"]\n}\n',
    );
    expect(() => withVersion(manifest, semver("0.1.9"), semver("0.2.0"), "m")).toThrow(
      'm: 0 "version": "0.1.9" fields, not one',
    );
  });

  test("the date is the local calendar day", () => {
    expect(String(localDate(new Date(2026, 9, 20, 23, 59)))).toBe("2026-10-20");
  });
});

describe("a plan on disk", () => {
  let root = "";

  let repo: PluginDir;

  function git(...args: string[]): string {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });

    if (result.exitCode !== 0) throw new Error(result.stderr.toString());

    return result.stdout.toString().trim();
  }

  function write(path: string, content: string) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  function commit(message: string): CommitId {
    git("add", "-A");
    git("commit", "-qm", message);

    return commitAt(repo, "HEAD");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "release-plan-"));
    mkdirSync(join(root, "repo"));

    const checked = pluginDirAt(join(root, "repo"));

    if (checked === null) throw new Error("no repo directory");

    repo = checked;
    git("init", "-q", "-b", "dev");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    write(
      ".claude-plugin/marketplace.json",
      JSON.stringify({ name: "t", plugins: [{ name: "vellum", source: "./vellum" }] }),
    );
    write(
      "vellum/.claude-plugin/plugin.json",
      JSON.stringify({ name: "vellum", version: "0.1.0" }),
    );
    write("vellum/CHANGELOG.md", "# Changelog\n\n## 0.1.0 - 2026-09-26\n\nFirst.\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a change lists the commits that touch the plugin's code, its documentation alone left out", () => {
    const shipped = commit("first");

    write("vellum/a.ts", "a\n");
    commit("feat(vellum): a\n\nWhy a.");
    write("vellum/docs/b.md", "b\n");
    commit("docs(vellum): b");
    write("elsewhere.md", "c\n");
    commit("docs: c");

    const [change, ...others] = changesOf(repo, shipped, commitAt(repo, "HEAD"));

    expect(others).toEqual([]);
    expect(change?.commits).toEqual([{ subject: "feat(vellum): a", body: "Why a." }]);
    expect(change?.version).toBe(semver("0.1.0"));
    expect(change?.diffstat).toContain("vellum/a.ts");
    expect(change?.changelog).toBe("# Changelog\n\n## 0.1.0 - 2026-09-26\n\nFirst.\n");
  });

  test("a change lists a commit to the file the manifest names under types, Claude Code's other API types left out", () => {
    write(
      "vellum/.claude-plugin/plugin.json",
      JSON.stringify({ name: "vellum", version: "0.1.0", types: "./types/claude-code.d.ts" }),
    );
    const shipped = commit("first");

    write("vellum/types/claude-code.d.ts", "declare const state: string;\n");
    commit("feat(vellum): declare the state");
    write("vellum/types/claude-code-tools.d.ts", "declare const tools: string;\n");
    commit("chore(vellum): the tools' types");

    const [change, ...others] = changesOf(repo, shipped, commitAt(repo, "HEAD"));

    expect(others).toEqual([]);
    expect(change?.commits).toEqual([{ subject: "feat(vellum): declare the state", body: "" }]);
  });

  test("is found by the digest it was sealed with, and by no other", () => {
    const head = commit("first");
    const plan: ReleasePlan = { shipped: head, target: head, bumps: [] };
    const sealed = sealPlan(repo, plan);

    expect(sealed.path).toBe(join(repo, ".git", "release-plan", `${head}.json`));
    expect(loadPlan(repo, sealed.digest)).toEqual(plan);
    expect(() => loadPlan(repo, "0123456789ab")).toThrow("has the digest 0123456789ab");
    expect(() => loadPlan(repo, "abc")).toThrow('"abc" is not a plan digest');

    writeFileSync(sealed.path, readFileSync(sealed.path, "utf8").replace("[]", "[ ]"));

    expect(() => loadPlan(repo, sealed.digest)).toThrow(`has the digest ${sealed.digest}`);
  });

  test("a digest with no plan made yet asks for the dry-run", () => {
    commit("first");

    expect(() => loadPlan(repo, "0123456789ab")).toThrow("run the dry-run first");
  });
});
