/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- this harness asserts on the JSON that codex-run.ts prints and writes: closed types would assert the schema instead of the behaviour, and a wrong shape has to fail an assertion rather than the compiler. */

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bridgeSchema,
  buildCodexArgs,
  parseFinalMessage,
  ROLES,
  summarizeEvents,
  WRITE_PREAMBLE,
} from "./codex-run.ts";

const SCRIPT = join(import.meta.dir, "codex-run.ts");

// A stand-in for the codex CLI: answers --version and debug models, and for
// exec logs its argv and stdin, then behaves as FAKE_CODEX_MODE says.
const FAKE_CODEX = `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const log = process.env.FAKE_CODEX_LOG;
if (args[0] === "--version") { console.log("codex-cli 9.9.9"); process.exit(0); }
if (args[0] === "debug") {
  const levels = (list) => list.map((effort) => ({ effort }));
  console.log(JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", visibility: "list", default_reasoning_level: "low", description: "workhorse",
      supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) },
    { slug: "gpt-6-astra", visibility: "list", default_reasoning_level: "low", description: "frontier",
      supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max", "ultra"]) },
    { slug: "gpt-6-luna", visibility: "list", default_reasoning_level: "medium", description: "fast",
      supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max"]) },
    { slug: "codex-auto-review", visibility: "hide", supported_reasoning_levels: [] },
  ] }));
  process.exit(0);
}
const stdin = await Bun.stdin.text();
appendFileSync(log, JSON.stringify({ args, stdin, cwd: process.cwd(), pin: process.env.AGENTS_BRIDGE_CODEX_VERSION }) + "\\n");
writeFileSync(log + ".pid", String(process.pid));
const out = args[args.indexOf("-o") + 1];
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "thread.started", thread_id: "thread-1" });
emit({ type: "turn.started" });
if (mode === "fail") { emit({ type: "turn.failed", error: { message: "boom" } }); process.exit(1); }
if (process.env.FAKE_CODEX_CHILD) writeFileSync(log + ".child", String(Bun.spawn(["sleep", "60"]).pid));
if (mode === "sleep") await Bun.sleep(Number(process.env.FAKE_CODEX_SLEEP ?? "30") * 1000);
writeFileSync(out, process.env.FAKE_CODEX_FINAL ?? "done");
emit({ type: "item.completed", item: { type: "agent_message", text: "done" } });
emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
`;

let tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `codex-run-test-${prefix}-`));

  tmpDirs.push(dir);

  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    for (const suffix of ["pid", "child"]) {
      const pidFile = join(dir, `codex.log.${suffix}`);

      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {}
      }
    }

    rmSync(dir, { recursive: true, force: true });
  }

  tmpDirs = [];
});

function alive(pidFile: string): boolean {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0);

    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;

  while (!condition()) {
    if (Date.now() >= deadline) return false;

    await Bun.sleep(20);
  }

  return true;
}

type Harness = {
  root: string;
  runDir: string;
  prompt: string;
  log: string;
  env: Record<string, string | undefined>;
};

function harness(extraEnv: Record<string, string> = {}): Harness {
  const root = makeTmpDir("run");
  const fake = join(root, "codex");

  writeFileSync(fake, FAKE_CODEX);
  chmodSync(fake, 0o755);

  const runDir = join(root, "run");
  const prompt = join(root, "prompt.md");

  Bun.spawnSync(["mkdir", runDir]);
  writeFileSync(prompt, "Do the thing.\n");

  const log = join(root, "codex.log");

  return {
    root,
    runDir,
    prompt,
    log,
    env: {
      ...process.env,
      HOME: root,
      AGENTS_BRIDGE_CODEX_BIN: fake,
      FAKE_CODEX_LOG: log,
      ...extraEnv,
    },
  };
}

type Output = {
  code: number;
  envelope: Record<string, any>;
  message: string | null;
  stderr: string;
};

async function cli(h: Harness, args: string[], env: Record<string, string> = {}): Promise<Output> {
  const proc = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: h.root,
    env: { ...h.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    // Its own process group: a command that signals its own group must not reach the runner.
    detached: true,
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const [first = "", ...rest] = stdout.split("\n");
  const markerAt = rest.indexOf("--- final message ---");

  return {
    code,
    envelope: first === "" ? {} : JSON.parse(first),
    message: markerAt === -1 ? null : rest.slice(markerAt + 1).join("\n"),
    stderr,
  };
}

function codexCalls(h: Harness): { args: string[]; stdin: string; cwd: string; pin?: string }[] {
  return readFileSync(h.log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

// A turn whose supervisor is dead, written by hand to stop at a chosen point of its start.
function deadTurn(h: Harness, files: Record<string, string>): string {
  const turnDir = join(h.runDir, "turn-1");

  mkdirSync(turnDir);
  writeFileSync(join(h.runDir, "run.json"), JSON.stringify({ cwd: h.root, mode: "read-only" }));
  writeFileSync(join(turnDir, "turn.json"), JSON.stringify({ turn: 1, deadline_seconds: 60 }));
  writeFileSync(join(turnDir, "supervisor.pid"), `${Bun.spawnSync(["true"]).pid}\n`);

  for (const [name, text] of Object.entries(files)) writeFileSync(join(turnDir, name), text);

  return turnDir;
}

const BEFORE_CODEX_PID = "after it began starting codex and before it recorded codex's pid";

const codexMayRun = (turnDir: string, why: string): string =>
  `the supervisor exited without writing a result, ${BEFORE_CODEX_PID}: codex may still be running, and codex-run could not list processes to find it (${why}). Find it with \`ps -A -ww -o pgid,args | grep -F -- '-o ${join(turnDir, "codex-final.txt")}'\`: a line that runs codex, not your search, starts with codex's process group. Stop codex and the commands it started with \`kill -KILL -- -<that group>\`.`;

const baseRun = {
  cwd: "/repo",
  mode: "write" as const,
  role: "coding" as const,
  model: "gpt-6.1-sol",
  effort: "xhigh",
  add_dirs: ["/repo/.git"],
  git_write: true,
  skip_git_repo_check: false,
  codex_version: "0.159.2",
  thread_id: "thread-1",
  created_at: "",
};

const baseSpec = {
  turn: 1,
  effort: null,
  deadline_seconds: 60,
  caller_schema: false,
  caller_type: null,
  caller_required: [],
  started_at: "",
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("buildCodexArgs", () => {
  test("a first write turn asks for auto-review and the bridge schema", () => {
    expect(buildCodexArgs(baseRun, baseSpec, "/t")).toEqual([
      "exec",
      "--approve-for-me",
      "--add-dir",
      "/repo/.git",
      "-C",
      "/repo",
      "-m",
      "gpt-6.1-sol",
      "-c",
      "model_reasoning_effort=xhigh",
      "--json",
      "-o",
      "/t/codex-final.txt",
      "--output-schema",
      "/t/schema.json",
      "-",
    ]);
  });

  test("a resume keeps the parent flags before the resume word", () => {
    const args = buildCodexArgs(baseRun, { ...baseSpec, turn: 2, effort: "high" }, "/t");
    const resumeAt = args.indexOf("resume");

    expect(args.slice(0, resumeAt)).toEqual([
      "exec",
      "--approve-for-me",
      "--add-dir",
      "/repo/.git",
      "-C",
      "/repo",
    ]);
    expect(args.slice(resumeAt, resumeAt + 2)).toEqual(["resume", "thread-1"]);
    expect(args).toContain("model_reasoning_effort=high");
  });

  test("a read-only turn with no model leaves model and effort to codex", () => {
    const run = { ...baseRun, mode: "read-only" as const, model: null, effort: null, add_dirs: [] };
    const args = buildCodexArgs(run, baseSpec, "/t");

    expect(args.slice(0, 3)).toEqual(["exec", "-s", "read-only"]);
    expect(args).not.toContain("-m");
    expect(args).not.toContain("--output-schema");
  });
});

describe("parseFinalMessage", () => {
  test("a write answer and its blocked items come out of the bridge object", () => {
    const blocked = [
      {
        action: "git push",
        cwd: "/repo",
        rationale: "remote write",
        cause: "review_denial" as const,
      },
    ];

    const parsed = parseFinalMessage(JSON.stringify({ answer: "done", blocked }), "write", null);

    expect(parsed).toEqual({ text: "done", blocked });
  });

  test("a write message that is not the bridge object fails", () => {
    expect(parseFinalMessage("done", "write", null)).toEqual({
      error: "the final message is not a bridge result object {answer, blocked}",
    });
  });

  test("a blocked item with an unknown cause fails rather than passing unblocked", () => {
    const text = JSON.stringify({
      answer: "x",
      blocked: [{ action: "a", cwd: "/", rationale: "r", cause: "other" }],
    });

    expect(parseFinalMessage(text, "write", null)).toHaveProperty("error");
  });

  test("a caller-schema answer is shown as formatted JSON", () => {
    const text = JSON.stringify({ answer: { verdict: "ship" }, blocked: [] });

    expect(parseFinalMessage(text, "write", { type: "object", required: [] })).toEqual({
      text: '{\n  "verdict": "ship"\n}\n',
      blocked: [],
    });
  });

  test("read-only text passes through, and must be JSON only under a caller schema", () => {
    expect(parseFinalMessage("# Review\nok", "read-only", null)).toEqual({
      text: "# Review\nok",
      blocked: [],
    });
    expect(
      parseFinalMessage("# Review", "read-only", { type: "object", required: [] }),
    ).toHaveProperty("error");
  });
});

describe("parseFinalMessage rejects what must not pass as success", () => {
  test("an empty final message", () => {
    expect(parseFinalMessage("  \n", "read-only", null)).toEqual({
      error: "codex wrote no final message",
    });
  });

  test("a bridge result with an extra property", () => {
    const text = JSON.stringify({ answer: "x", blocked: [], note: "extra" });

    expect(parseFinalMessage(text, "write", null)).toHaveProperty("error");
  });

  test("an answer whose type is not the caller schema's type", () => {
    const text = JSON.stringify({ answer: null, blocked: [] });

    expect(parseFinalMessage(text, "write", { type: "object", required: [] })).toEqual({
      error: "answer does not match the schema's type and required keys",
    });
  });
});

describe("parseFinalMessage enforces the strict bridge result and the caller schema", () => {
  test("a missing required key of the caller schema", () => {
    const text = JSON.stringify({ answer: {}, blocked: [] });

    expect(
      parseFinalMessage(text, "write", { type: "object", required: ["value"] }),
    ).toHaveProperty("error");
  });

  test("a required key only inherited from Object.prototype", () => {
    const text = JSON.stringify({ answer: {}, blocked: [] });

    expect(
      parseFinalMessage(text, "write", { type: "object", required: ["constructor"] }),
    ).toHaveProperty("error");
  });

  test("a blocked item with an extra property", () => {
    const item = { action: "a", cwd: "/", rationale: "r", cause: "review_denial", extra: 1 };

    expect(
      parseFinalMessage(JSON.stringify({ answer: "x", blocked: [item] }), "write", null),
    ).toHaveProperty("error");
  });
});

describe("bridgeSchema", () => {
  test("embeds the caller schema as the answer property", () => {
    const schema = JSON.parse(
      bridgeSchema('{"type":"object","properties":{"v":{"type":"string"}}}'),
    );

    expect(schema.required).toEqual(["answer", "blocked"]);
    expect(schema.properties.answer.properties.v.type).toBe("string");
    expect(schema.properties.blocked.items.properties.cause.enum).toEqual([
      "review_denial",
      "sandbox_failure",
    ]);
  });
});

describe("summarizeEvents", () => {
  test("reads the thread id, completion and a turn failure, and skips reconnect errors", () => {
    const ok = summarizeEvents(
      [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"error","message":"Reconnecting... 1/5"}',
        '{"type":"turn.completed","usage":{}}',
      ].join("\n"),
    );

    expect(ok).toEqual({ threadId: "t1", completed: true, turnError: null });
    expect(summarizeEvents('{"type":"turn.failed","error":{"message":"boom"}}').turnError).toBe(
      "boom",
    );
  });
});

// ---------------------------------------------------------------------------
// The CLI against a fake codex
// ---------------------------------------------------------------------------

describe("codex-run CLI", () => {
  test("start runs a write turn to completion and records the resolved settings", async () => {
    const h = harness({ FAKE_CODEX_FINAL: JSON.stringify({ answer: "all done", blocked: [] }) });

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--mode",
      "write",
      "--role",
      "coding",
    ]);

    expect(out.code).toBe(0);
    expect(out.envelope.status).toBe("completed");
    expect(out.envelope.model).toBe(ROLES.coding.model);
    expect(out.envelope.effort).toBe(ROLES.coding.effort);
    expect(out.envelope.codex_version).toBe("9.9.9");
    expect(out.message).toBe("all done\n");

    const [call] = codexCalls(h);

    expect(call?.args).toContain("--approve-for-me");
    expect(call?.stdin.startsWith(WRITE_PREAMBLE)).toBe(true);
    expect(call?.stdin).toContain("Do the thing.");
    expect(JSON.parse(readFileSync(join(h.runDir, "run.json"), "utf8")).thread_id).toBe("thread-1");
  });

  test("resume replays the first turn's settings on the same thread", async () => {
    const h = harness({ FAKE_CODEX_FINAL: JSON.stringify({ answer: "ok", blocked: [] }) });

    await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--mode",
      "write",
      "--role",
      "bounded",
    ]);
    const out = await cli(h, ["resume", h.runDir, "--prompt-file", h.prompt]);

    expect(out.code).toBe(0);
    expect(out.envelope.turn).toBe(2);

    const second = codexCalls(h)[1]?.args ?? [];

    expect(second.slice(second.indexOf("resume"), second.indexOf("resume") + 2)).toEqual([
      "resume",
      "thread-1",
    ]);
    expect(second.indexOf("--approve-for-me")).toBeLessThan(second.indexOf("resume"));
    expect(second).toContain(ROLES.bounded.model);
    expect(second).toContain(`model_reasoning_effort=${ROLES.bounded.effort}`);
  });

  test("a denied action ends the turn as blocked, exit 11", async () => {
    const blocked = [
      {
        action: "git push origin main",
        cwd: "/r",
        rationale: "remote write",
        cause: "review_denial",
      },
    ];

    const h = harness({ FAKE_CODEX_FINAL: JSON.stringify({ answer: "pushed nothing", blocked }) });
    const out = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--mode", "write"]);

    expect(out.code).toBe(11);
    expect(out.envelope.status).toBe("blocked");
    expect(out.envelope.blocked).toEqual(blocked);
  });

  test("a failed turn reports codex's error, exit 1", async () => {
    const h = harness({ FAKE_CODEX_MODE: "fail" });
    const out = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt]);

    expect(out.code).toBe(1);
    expect(out.envelope.error).toBe("boom");
  });

  test("a read-only turn keeps free text and sends no preamble", async () => {
    const h = harness({ FAKE_CODEX_FINAL: "# Review\nSHIP" });
    const out = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--role", "audit"]);

    expect(out.code).toBe(0);
    expect(out.message).toBe("# Review\nSHIP\n");
    expect(codexCalls(h)[0]?.stdin).toBe("Do the thing.\n");
  });

  test("a turn that outlives --wait returns 10, and wait picks it up", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "2" });
    const first = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);

    expect(first.code).toBe(10);
    expect(first.envelope.status).toBe("running");
    expect(first.message).toBeNull();

    const busy = await cli(h, ["resume", h.runDir, "--prompt-file", h.prompt]);

    expect(busy.code).toBe(2);

    const done = await cli(h, ["wait", h.runDir, "--timeout", "20"]);

    expect(done.code).toBe(0);
    expect(done.message).toBe("done\n");
  });

  test("the deadline interrupts codex, exit 124", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--deadline",
      "1",
      "--wait",
      "20",
    ]);

    expect(out.code).toBe(124);
    expect(out.envelope.status).toBe("deadline");
  });

  test("cancel interrupts a running turn, exit 130", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });

    await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);
    await Bun.sleep(500);
    const out = await cli(h, ["cancel", h.runDir]);

    expect(out.code).toBe(130);
    expect(out.envelope.status).toBe("cancelled");
  });

  test("cancel right after start, before the supervisor is ready, still cancels", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });

    await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);
    const out = await cli(h, ["cancel", h.runDir]);

    expect(out.code).toBe(130);
    expect(out.envelope.status).toBe("cancelled");
  });

  test("a supervisor that dies is reported as a failed turn, and status exits 0", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });

    const turnDir = join(h.runDir, "turn-1");
    const supervisorPid = join(turnDir, "supervisor.pid");

    const codexRecorded = (): boolean =>
      existsSync(join(turnDir, "ready")) && existsSync(`${h.log}.pid`);

    await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);
    expect(await waitUntil(codexRecorded)).toBe(true);
    process.kill(Number(readFileSync(supervisorPid, "utf8")), "SIGKILL");
    expect(await waitUntil(() => !alive(supervisorPid))).toBe(true);

    const out = await cli(h, ["status", h.runDir]);

    expect(out.code).toBe(0);
    expect(out.envelope.status).toBe("failed");
    expect(out.envelope.error).toBe("the supervisor exited without writing a result");
    expect(await waitUntil(() => !alive(`${h.log}.pid`))).toBe(true);
  });

  test("a supervisor killed before it records codex's pid leaves a codex that status finds by its turn file and stops", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });
    const turnDir = join(h.runDir, "turn-1");
    const supervisorPid = join(turnDir, "supervisor.pid");

    await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);
    expect(
      await waitUntil(() => existsSync(join(turnDir, "ready")) && existsSync(`${h.log}.pid`)),
    ).toBe(true);
    process.kill(Number(readFileSync(supervisorPid, "utf8")), "SIGKILL");
    expect(await waitUntil(() => !alive(supervisorPid))).toBe(true);
    rmSync(join(turnDir, "codex.pid"));
    rmSync(join(turnDir, "ready"));

    const codexPid = Number(readFileSync(`${h.log}.pid`, "utf8"));
    const out = await cli(h, ["status", h.runDir]);

    expect(out.code).toBe(0);
    expect(out.envelope.status).toBe("failed");
    expect(out.envelope.error).toBe(
      `the supervisor exited without writing a result, ${BEFORE_CODEX_PID}; codex-run found codex's process group ${codexPid} by its turn file and stopped it`,
    );
    expect(await waitUntil(() => !alive(`${h.log}.pid`))).toBe(true);
  });

  test("a turn whose codex is gone before its pid was recorded says nothing was running", async () => {
    const h = harness();

    deadTurn(h, { "events.jsonl": "" });

    const out = await cli(h, ["status", h.runDir]);

    expect(out.envelope.status).toBe("failed");
    expect(out.envelope.error).toBe(
      `the supervisor exited without writing a result, ${BEFORE_CODEX_PID}; no codex process for this turn was running`,
    );
  });

  // "1" is tested through supervisor.pid only: a parser that let it through here would
  // `kill -9 -1`, every process of the user running the tests.
  test.each(["", "0", "-1", "abc", "4294967296"])(
    "a dead supervisor's codex.pid holding %p is no pid, and status searches for codex instead",
    async (text) => {
      const h = harness();
      const turnDir = deadTurn(h, { "events.jsonl": "", "codex.pid": text });
      const out = await cli(h, ["status", h.runDir]);

      expect(out.code).toBe(0);
      expect(out.envelope.status).toBe("failed");
      expect(out.envelope.error).toBe(
        `the supervisor exited without writing a result, and ${join(turnDir, "codex.pid")} holds no valid pid; no codex process for this turn was running`,
      );
    },
  );

  test.each([
    ["fails", 'echo "ps: no listing" >&2\nexit 1', "ps exited 1: ps: no listing"],
    [
      "prints no process table",
      'echo "not a table"',
      "ps printed a line that is not a pid, a process group and a command: not a table",
    ],
    [
      "leaves codex-run out",
      'echo "  999999  999999 sleep 60"',
      "ps did not list codex-run itself",
    ],
  ])(
    "a process listing that %s leaves codex to Claude, with the commands that find and stop it",
    async (_, script, why) => {
      const h = harness();
      const bin = join(h.root, "bin");

      mkdirSync(bin);
      writeFileSync(join(bin, "ps"), `#!/bin/sh\n${script}\n`);
      chmodSync(join(bin, "ps"), 0o755);

      const turnDir = deadTurn(h, { "events.jsonl": "" });

      const out = await cli(h, ["status", h.runDir], {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      });

      expect(out.code).toBe(0);
      expect(out.envelope.status).toBe("failed");
      expect(out.envelope.error).toBe(codexMayRun(turnDir, why));
    },
  );

  test("a supervisor dead before it starts codex is a failed turn with nothing left running", async () => {
    const h = harness();

    deadTurn(h, {});

    const out = await cli(h, ["status", h.runDir]);

    expect(out.envelope.status).toBe("failed");
    expect(out.envelope.error).toBe("the supervisor exited without writing a result");
  });

  test.each(["", "0", "1", "-1", "abc", "4294967296"])(
    "a supervisor.pid holding %p ends the turn as failed instead of leaving it running forever",
    async (text) => {
      const h = harness();
      const turnDir = deadTurn(h, { "supervisor.pid": text, "events.jsonl": "" });
      const out = await cli(h, ["status", h.runDir]);

      expect(out.code).toBe(0);
      expect(out.envelope.status).toBe("failed");
      expect(out.envelope.error).toBe(
        `${join(turnDir, "supervisor.pid")} holds no valid pid, so codex-run treats the supervisor as gone, ${BEFORE_CODEX_PID}; no codex process for this turn was running`,
      );
    },
  );

  test("a process that only names the turn file, without codex's -o, is left alone", async () => {
    const h = harness();
    const turnDir = deadTurn(h, { "events.jsonl": "" });

    const reader = Bun.spawn(["sh", "-c", "sleep 30; :", "sh", join(turnDir, "codex-final.txt")], {
      detached: true,
    });

    try {
      const out = await cli(h, ["status", h.runDir]);

      expect(out.envelope.error).toBe(
        `the supervisor exited without writing a result, ${BEFORE_CODEX_PID}; no codex process for this turn was running`,
      );
      expect(reader.exitCode).toBeNull();
    } finally {
      reader.kill("SIGKILL");
    }
  });

  test("status finds codex through another spelling of the run directory", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30" });
    const link = `${h.runDir}-link`;
    const turnDir = join(h.runDir, "turn-1");
    const supervisorPid = join(turnDir, "supervisor.pid");

    symlinkSync(h.runDir, link);
    await cli(h, ["start", link, "--prompt-file", h.prompt, "--wait", "0"]);
    expect(
      await waitUntil(() => existsSync(join(turnDir, "ready")) && existsSync(`${h.log}.pid`)),
    ).toBe(true);
    process.kill(Number(readFileSync(supervisorPid, "utf8")), "SIGKILL");
    expect(await waitUntil(() => !alive(supervisorPid))).toBe(true);
    rmSync(join(turnDir, "codex.pid"));

    const out = await cli(h, ["status", h.runDir]);

    expect(out.envelope.error).toContain("by its turn file and stopped it");
    expect(await waitUntil(() => !alive(`${h.log}.pid`))).toBe(true);
  });

  test("an unknown model or effort is a usage error that lists the catalog", async () => {
    const h = harness();
    const model = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "-m", "gpt-9"]);

    expect(model.code).toBe(2);
    expect(model.stderr).toContain("gpt-6.1-sol, gpt-6-astra, gpt-6-luna");

    const effort = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--role",
      "bounded",
      "--effort",
      "ultra",
    ]);

    expect(effort.code).toBe(2);
    expect(existsSync(join(h.runDir, "run.json"))).toBe(false);
  });

  test("--git-write grants the repository's git directories", async () => {
    const h = harness({ FAKE_CODEX_FINAL: JSON.stringify({ answer: "ok", blocked: [] }) });
    const repo = join(h.root, "repo");

    Bun.spawnSync(["git", "init", "-q", repo]);

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--mode",
      "write",
      "-C",
      repo,
      "--git-write",
    ]);

    expect(out.code).toBe(0);
    expect(out.envelope.add_dirs).toEqual([join(repo, ".git")]);
    expect(codexCalls(h)[0]?.cwd).toBe(repo);
  });

  test("--codex-version pins the CLI for every turn of the run", async () => {
    const h = harness();

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--codex-version",
      "1.2.3",
    ]);

    expect(out.envelope.codex_version).toBe("1.2.3");
    expect(codexCalls(h)[0]?.pin).toBe("1.2.3");
  });

  test("cancel also stops the commands codex started", async () => {
    const h = harness({ FAKE_CODEX_MODE: "sleep", FAKE_CODEX_SLEEP: "30", FAKE_CODEX_CHILD: "1" });

    await cli(h, ["start", h.runDir, "--prompt-file", h.prompt, "--wait", "0"]);
    await Bun.sleep(800);
    expect(alive(`${h.log}.child`)).toBe(true);

    const out = await cli(h, ["cancel", h.runDir]);

    expect(out.code).toBe(130);
    await Bun.sleep(200);
    expect(alive(`${h.log}.child`)).toBe(false);
  });

  test("write mode refuses a caller schema with $ref pointers", async () => {
    const h = harness();
    const schema = join(h.root, "schema.json");

    writeFileSync(
      schema,
      JSON.stringify({ type: "object", properties: { r: { $ref: "#/$defs/R" } } }),
    );

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--mode",
      "write",
      "--output-schema",
      schema,
    ]);

    expect(out.code).toBe(2);
    expect(out.stderr).toContain("inline the definitions");
  });

  test("write mode also refuses a $ref key written with a unicode escape", async () => {
    const h = harness();
    const schema = join(h.root, "schema.json");

    writeFileSync(schema, '{"type":"object","properties":{"r":{"\\u0024ref":"#/$defs/R"}}}');

    const out = await cli(h, [
      "start",
      h.runDir,
      "--prompt-file",
      h.prompt,
      "--mode",
      "write",
      "--output-schema",
      schema,
    ]);

    expect(out.code).toBe(2);
  });

  test("a turn that ends without a final message fails", async () => {
    const h = harness({ FAKE_CODEX_FINAL: "" });
    const out = await cli(h, ["start", h.runDir, "--prompt-file", h.prompt]);

    expect(out.code).toBe(1);
    expect(out.envelope.error).toBe("codex wrote no final message");
  });

  test("new creates a private run directory under the run kind", () => {
    const h = harness();
    const proc = Bun.spawnSync(["bun", SCRIPT, "new", "critique"], { env: h.env });
    const dir = proc.stdout.toString().trim();

    expect(proc.exitCode).toBe(0);
    expect(dir.startsWith(join(h.root, ".cache", "agents-bridge", "critique", "run."))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
