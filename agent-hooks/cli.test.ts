/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this harness builds hook payloads and reads hook outputs as JSON: a closed type would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { isRecord } from "./json.ts";
import { statePath } from "./state.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  fakeTool,
  fixtureIn,
  fixtureNames,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

const CLI = path.join(import.meta.dir, "agent-hooks.ts");

const MISSING_TOOL_EXAMPLE = path.join(
  import.meta.dir,
  "presets",
  "examples",
  "missing-tool.jsonc",
);

const BAD_CHECKER =
  'status=0; for f in "$@"; do if grep -q BAD "$f"; then echo "$f:1:1: bad"; status=1; fi; done; exit $status';

const CONFIG = JSON.stringify({
  stop: {
    lanes: {
      lint: { on: "**/*.ts", takes: "files", run: "checker {files}" },
      docs: { on: "**/*.md", takes: "files", run: "docs-checker {files}" },
    },
  },
});

const FIXTURES = (["claude", "codex"] as const).flatMap((harness) =>
  fixtureNames(harness).map((fixture) => [harness, fixture] as const),
);

type CliResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

type CliOptions = { readonly cwd: string; readonly stateDir: string; readonly stdin?: string };

async function cli(args: readonly string[], options: CliOptions): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      AGENT_HOOKS_STATE_DIR: options.stateDir,
      PATH: process.env["PATH"] ?? "",
    },
    stdin: options.stdin === undefined ? "ignore" : new Response(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

function hookOf(fixture: string): string {
  const prefix = ["session-start", "pre-edit", "post-edit", "stop"].find((hook) =>
    fixture.startsWith(hook),
  );

  if (prefix === undefined) {
    throw new Error(`no hook for fixture ${fixture}`);
  }

  return prefix;
}

function parsedObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);

  if (!isRecord(value)) {
    throw new Error(`${text} is not a JSON object`);
  }

  return value;
}

function listTree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).toSorted();
}

describe("agent-hooks CLI", () => {
  let temp: TempRepo;

  beforeEach(() => {
    scrubGitEnv();
    temp = createTempRepo("agent-hooks-cli-", {
      ".gitignore": "node_modules/\n",
      [CONFIG_RELATIVE_PATH]: CONFIG,
      "src/old.ts": "ok\n",
      "capture/sample.md": "# Sample\n\nhello\n",
    });
    fakeTool(temp.repo, "checker", BAD_CHECKER);
    fakeTool(temp.repo, "docs-checker", "exit 0");
  });

  afterEach(() => {
    removeTempRepo(temp);
  });

  const options = (stdin?: string): CliOptions =>
    stdin === undefined
      ? { cwd: temp.repo, stateDir: temp.stateDir }
      : { cwd: temp.repo, stateDir: temp.stateDir, stdin };

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the harness feeds the CLI fixtures and hand-built payloads of every hook's shape; the CLI under test is their parser.
  function hook(name: string, payload: unknown, harness = "claude"): Promise<CliResult> {
    return cli([name, "--harness", harness], options(JSON.stringify(payload)));
  }

  test.each(FIXTURES)("%s/%s exits 0 with empty or JSON stdout", async (harness, fixture) => {
    const result = await hook(hookOf(fixture), fixtureIn(harness, fixture, temp.repo), harness);

    expect(result.code).toBe(0);

    if (result.stdout.trim() !== "") {
      expect(parsedObject(result.stdout)).toBeObject();
    }
  });

  test("session-start writes the state file", async () => {
    const result = await hook(
      "session-start",
      fixtureIn("claude", "session-start-startup", temp.repo),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(existsSync(statePath("s1", temp.repo))).toBe(true);
  });

  test("stop blocks on a file added after the photo", async () => {
    await hook("session-start", fixtureIn("claude", "session-start-startup", temp.repo));
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const result = await hook("stop", fixtureIn("claude", "stop", temp.repo));

    expect(result.code).toBe(0);

    const output = parsedObject(result.stdout);

    expect(output["decision"]).toBe("block");
    expect(String(output["reason"])).toContain("src/new.ts");
  });

  test("an unknown harness exits 0 with a stderr line and no output", async () => {
    const result = await hook("stop", fixtureIn("claude", "stop", temp.repo), "nope");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown harness");
  });

  test("no arguments exits 2 with the usage", async () => {
    const result = await cli([], options());

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage:");
  });

  test("an empty stdin exits 0 without output", async () => {
    const result = await cli(["stop"], options(""));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("verify exits 1 on a failing block lane and prints one line per lane", async () => {
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");

    const result = await cli(["verify"], options());

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("scope: src/old.ts");
    expect(result.stdout).toMatch(/^lint: fail/mu);
    expect(result.stdout).toMatch(/^docs: skipped$/mu);
  });

  test("verify exits 0 when every lane passes", async () => {
    writeRepoFile(temp.repo, "src/old.ts", "fine\n");
    writeRepoFile(temp.repo, "README.md", "# readme\n");

    const result = await cli(["verify"], options());

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^lint: ok/mu);
    expect(result.stdout).toMatch(/^docs: ok/mu);
  });

  test("verify --all checks the files dirty before the photo", async () => {
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");
    await hook("session-start", fixtureIn("claude", "session-start-startup", temp.repo));
    writeRepoFile(temp.repo, "src/new.ts", "fine\n");

    const session = await cli(["verify"], options());

    expect(session.code).toBe(0);
    expect(session.stdout).toContain("scope: src/new.ts\n");

    const all = await cli(["verify", "--all"], options());

    expect(all.code).toBe(1);
    expect(all.stdout).toContain("scope: src/new.ts src/old.ts\n");
  });

  test("verify <file> restricts the scope to that file", async () => {
    writeRepoFile(temp.repo, "src/old.ts", "BAD\n");
    writeRepoFile(temp.repo, "src/new.ts", "fine\n");

    const result = await cli(["verify", "src/new.ts"], options());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scope: src/new.ts\n");
    expect(result.stdout).toMatch(/^lint: ok/mu);
  });

  test("verify <file> from a subdirectory takes the file from that directory", async () => {
    writeRepoFile(temp.repo, "src/new.ts", "BAD\n");

    const result = await cli(["verify", "new.ts"], {
      cwd: path.join(temp.repo, "src"),
      stateDir: temp.stateDir,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("scope: src/new.ts\n");
    expect(result.stdout).toMatch(/^lint: fail/mu);
  });

  test("verify refuses a file outside the root and runs nothing", async () => {
    const result = await cli(["verify", "../elsewhere.ts"], options());

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`agent-hooks: ../elsewhere.ts is outside ${temp.repo}`);
    expect(result.stdout).not.toContain("lint:");
  });

  test("verify takes a file whose name starts with two dots as a file of the root", async () => {
    writeRepoFile(temp.repo, "..config.ts", "BAD\n");

    const result = await cli(["verify", "..config.ts"], options());

    expect(result.stdout).toContain("scope: ..config.ts\n");
    expect(result.stdout).toMatch(/^lint: fail/mu);
  });

  test("verify refuses a named file that is neither on disk nor a deletion git knows", async () => {
    const result = await cli(["verify", "src/typo.ts"], options());

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("agent-hooks: no such file: src/typo.ts");
    expect(result.stdout).not.toContain("scope:");
  });

  test("verify keeps a tracked file deleted in the tree in its scope", async () => {
    rmSync(path.join(temp.repo, "src/old.ts"));

    const result = await cli(["verify", "src/old.ts"], options());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scope: src/old.ts\n");
  });

  test("doctor exits 0 when every tool resolves", async () => {
    const result = await cli(["doctor"], options());

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`root: ${temp.repo}\n`);
    expect(result.stdout).toContain(
      `ok      lane lint: ${path.join(temp.repo, "node_modules", ".bin", "checker")}`,
    );
    expect(result.stdout).toContain(
      `ok      lane docs: ${path.join(temp.repo, "node_modules", ".bin", "docs-checker")}`,
    );
    expect(result.stdout).toMatch(/^photo: /mu);
  });

  test("doctor checks a bun run script in the package named by --cwd", async () => {
    writeRepoFile(temp.repo, "apps/web/package.json", '{ "scripts": { "test:unit": "true" } }\n');
    writeConfig(
      temp.repo,
      JSON.stringify({
        stop: {
          lanes: {
            present: { on: "**/*", takes: "project", run: "bun run --cwd apps/web test:unit" },
            absent: { on: "**/*", takes: "project", run: "bun run --cwd apps/web nope" },
          },
        },
      }),
    );

    const result = await cli(["doctor"], options());

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^ok {6}lane present: /mu);
    expect(result.stdout).toContain(
      `MISSING lane absent: no "nope" script in ${path.join(temp.repo, "apps", "web", "package.json")}`,
    );
  });

  test("doctor --config reports a lane whose tool is missing", async () => {
    const result = await cli(["doctor", "--config", MISSING_TOOL_EXAMPLE], options());

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("MISSING lane nope: no-such-tool-for-doctor");
  });

  test("doctor says once that a root outside git is checked by nothing", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "agent-hooks-cli-outside-git-"));

    try {
      writeConfig(outside, CONFIG);
      fakeTool(outside, "checker", BAD_CHECKER);
      fakeTool(outside, "docs-checker", "exit 0");

      const result = await cli(["doctor"], { cwd: outside, stateDir: temp.stateDir });

      expect(result.code).toBe(1);
      expect(result.stdout).toContain(`MISSING checkout: ${outside} is outside git`);
      expect(result.stdout).not.toContain("git status failed");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("agent-hooks init --print", () => {
  let dir: string;
  const stateDir = (): string => path.join(dir, "state");

  beforeEach(() => {
    scrubGitEnv();
    dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-init-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function init(cwd: string): Promise<string> {
    const before = listTree(cwd);
    const result = await cli(["init", "--print"], { cwd, stateDir: stateDir() });

    expect(result.code).toBe(0);
    expect(listTree(cwd)).toEqual(before);

    return result.stdout;
  }

  test("proposes the ts preset for a package.json", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project);
    writeFileSync(path.join(project, "package.json"), "{}\n");

    expect(await init(project)).toContain('"presets": ["ts"]');
  });

  test("proposes the rust preset for a Cargo.toml in a subdirectory", async () => {
    const project = path.join(dir, "project");
    mkdirSync(path.join(project, "crates", "tool"), { recursive: true });
    writeFileSync(path.join(project, "crates", "tool", "Cargo.toml"), "[package]\n");

    expect(await init(project)).toContain('"presets": ["rust"]');
  });

  test("spells out the edition of a root Cargo.toml for rustfmt", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "Cargo.toml"), '[workspace.package]\nedition = "2024"\n');

    const output = await init(project);

    expect(output).toContain('"presets": ["rust"]');
    expect(output).toContain('"rustfmt": { "stdin": "rustfmt --edition 2024" }');
  });

  test("proposes both presets for both files", async () => {
    const project = path.join(dir, "project");
    mkdirSync(path.join(project, "crates", "tool"), { recursive: true });
    writeFileSync(path.join(project, "package.json"), "{}\n");
    writeFileSync(path.join(project, "crates", "tool", "Cargo.toml"), "[package]\n");

    expect(await init(project)).toContain('"presets": ["ts","rust"]');
  });
});
