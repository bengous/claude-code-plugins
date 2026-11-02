import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { collect, decide } from "./gate.ts";
import {
  contextIn,
  FakeGitHub,
  fakeNetwork,
  type History,
  landHistory,
  NO_NPM,
  npmWith,
  type Sandbox,
  sandbox,
} from "./harness.fixture.ts";
import { PR_409_BODY, SDK_TYPES_DIFF } from "./leads.fixture.ts";
import { dryRun, type Json, parseJson, scanMarker } from "./lib.ts";

const NOW = Date.parse("2026-10-30T06:00:00Z");

const OPTIONS = { sinceDays: 7, max: 10, stats: true };

const FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_minor/fire";

const FIRE_ENV = { LEADS_FIRE_URL_MINOR: FIRE_URL, LEADS_FIRE_TOKEN_MINOR: "sk-ant-oat01-secret" };

const SESSION = "https://claude.ai/code/session_01ABC";

let box: Sandbox;

let shas: History;

let gh: FakeGitHub;

beforeEach(() => {
  box = sandbox();
  shas = landHistory(box);
  gh = new FakeGitHub();
  gh.pulls.set(shas.zustand, [
    {
      number: 409,
      user: { login: "renovate[bot]" },
      head: { ref: "renovate/zustand-5.x" },
      body: PR_409_BODY,
    },
  ]);
});

afterEach(() => {
  box.cleanup();
});

function factsOf(printed: readonly string[]): Json {
  const line = printed.find((entry) => entry.startsWith("<leads-facts>")) ?? "";

  return parseJson(line.replaceAll(/^<leads-facts>|<\/leads-facts>$/gu, ""));
}

function writeVerdicts(verdicts: Json): string {
  const file = join(box.root, ".leads", "verdicts.json");

  writeFileSync(file, JSON.stringify(verdicts));

  return ".leads/verdicts.json";
}

function zustandVerdict(verdict: string) {
  return [
    {
      sha: shas.zustand.slice(0, 8),
      package: "zustand",
      verdict,
      reason: "the perf fix reaches useStore, which vellum/src/state.ts calls",
    },
  ];
}

function ledgerLines(): string[] {
  return gh.issues
    .filter((issue) => issue.labels.includes("lead:ledger"))
    .flatMap((issue) => issue.comments.map((comment) => comment.body));
}

function scanIssues() {
  return gh.issues.filter((issue) => issue.labels.includes("lead:scan-minor"));
}

describe("collect", () => {
  test("records the updates no model needs, and hands the rest to the gate with their facts", async () => {
    const { ctx, printed } = contextIn(box, gh, { npm: npmWith("") });

    expect(await collect(ctx, OPTIONS, NOW)).toBe(0);

    const [ledger] = gh.issues;

    expect(ledger?.labels).toEqual(["lead:ledger"]);
    expect(ledger?.state).toBe("closed");
    expect(ledger?.locked).toBe(true);

    expect(ledgerLines()).toEqual([
      `${shas.sdk.slice(0, 7)} @anthropic-ai/claude-agent-sdk@0.3.311→0.3.312 skip — patch with no notes`,
      `${shas.ci.slice(0, 7)} (none) skip — no npm manifest change`,
      `${shas.pin.slice(0, 7)} oxfmt@^0.73.0→0.73.0 skip — pin`,
      `${shas.elkjs.slice(0, 7)} elkjs@0.12.0→0.12.1 skip — no code site`,
    ]);

    const facts = factsOf(printed);

    expect(facts).toMatchObject({
      skipped: [{}, {}, {}, {}],
      deferred: 0,
      candidates: [
        {
          sha: shas.zustand,
          package: "zustand",
          from: "5.0.15",
          to: "5.0.16",
          updateType: "patch",
          manifests: ["vellum/package.json"],
          usage: {
            codeSites: 2,
            files: ["vellum/src/state.ts"],
            markers: [
              "vellum/src/state.ts:2: // TODO: drop the memo until zustand fixes getServerSnapshot",
            ],
          },
          notes: {
            source: "pr#409",
            compare: "https://github.com/pmndrs/zustand/compare/v5.0.15...v5.0.16",
          },
          types: { source: "npm-diff", files: 0 },
        },
      ],
    });

    expect(JSON.stringify(facts)).toContain("don't memoize");

    const gate = parseJson(readFileSync(join(box.root, ".leads", "gate.json"), "utf8"));

    expect(gate).toMatchObject({
      candidates: [{ package: "zustand", notes: { source: "pr#409" } }],
    });
    expect(JSON.stringify(gate)).not.toContain("don't memoize");
    expect(printed).toContain(
      "stats: 5 read, 4 skipped (patch with no notes 1, no npm manifest change 1, pin 1, no code site 1), 1 candidates, 0 deferred",
    );
  });

  test("removes the verdicts an earlier run left, so the model writes them afresh", async () => {
    mkdirSync(join(box.root, ".leads"), { recursive: true });
    writeVerdicts(zustandVerdict("skip"));

    await collect(contextIn(box, gh, { npm: npmWith("") }).ctx, OPTIONS, NOW);

    expect(existsSync(join(box.root, ".leads", "verdicts.json"))).toBe(false);
  });

  test("a second run finds the ledger and adds nothing to it", async () => {
    await collect(contextIn(box, gh, { npm: npmWith("") }).ctx, OPTIONS, NOW);
    gh.takeWrites();

    const { ctx, printed } = contextIn(box, gh, { npm: npmWith("") });

    expect(await collect(ctx, OPTIONS, NOW)).toBe(0);
    expect(gh.takeWrites()).toEqual([]);
    expect(factsOf(printed)).toMatchObject({ skipped: [], candidates: [{ package: "zustand" }] });
  });

  test("past its budget a package update waits for the next run, unread", async () => {
    const { ctx, printed } = contextIn(box, gh, { npm: npmWith("") });

    await collect(ctx, { ...OPTIONS, max: 1 }, NOW);

    expect(factsOf(printed)).toMatchObject({ deferred: 3, candidates: [{ package: "zustand" }] });
    expect(ledgerLines()).toEqual([`${shas.ci.slice(0, 7)} (none) skip — no npm manifest change`]);
  });

  test("a later run reads what an earlier one deferred or left undecided, however old", async () => {
    await collect(contextIn(box, gh, { npm: npmWith("") }).ctx, { ...OPTIONS, max: 1 }, NOW);

    const later = contextIn(box, gh, { npm: npmWith("") });

    await collect(later.ctx, OPTIONS, NOW + 20 * 86_400_000);

    expect(factsOf(later.printed)).toMatchObject({
      skipped: [
        { sha: shas.sdk, reason: "patch with no notes" },
        { sha: shas.pin, reason: "pin" },
        { sha: shas.elkjs, reason: "no code site" },
      ],
      deferred: 0,
      candidates: [{ package: "zustand" }],
    });
  });

  test("an update skipped on its size or sites costs no notes", async () => {
    const network = fakeNetwork(() => null);
    const { ctx } = contextIn(box, gh, { npm: npmWith(""), fetch: network.fetch });

    await collect(ctx, OPTIONS, NOW);

    expect(network.calls.map((call) => call.url)).toEqual(
      ["v0.3.312", "0.3.312", "%40anthropic-ai%2Fclaude-agent-sdk%400.3.312"].flatMap((tag) => [
        `https://raw.githubusercontent.com/o/r/${tag}/packages/claude-agent-sdk/CHANGELOG.md`,
        `https://raw.githubusercontent.com/o/r/${tag}/CHANGELOG.md`,
      ]),
    );
  });

  test("with no npm, the typed diff is unavailable and the update still reaches the gate", async () => {
    const { ctx, printed } = contextIn(box, gh, { npm: NO_NPM });

    await collect(ctx, OPTIONS, NOW);

    expect(factsOf(printed)).toMatchObject({
      candidates: [{ package: "zustand", types: { source: "unavailable", files: 0 } }],
    });
  });

  test("a typed diff's declarations reach the gate", async () => {
    const { ctx, printed } = contextIn(box, gh, { npm: npmWith(SDK_TYPES_DIFF) });

    await collect(ctx, OPTIONS, NOW);

    expect(factsOf(printed)).toMatchObject({
      candidates: [{ types: { source: "npm-diff", files: 2, deprecated: [expect.any(String)] } }],
    });
  });
});

async function collected(): Promise<void> {
  await collect(contextIn(box, gh, { npm: npmWith("") }).ctx, OPTIONS, NOW);
  gh.takeWrites();
}

describe("decide", () => {
  test("files the scan issue, records it, then fires the scan task once", async () => {
    await collected();

    const network = fakeNetwork((url) =>
      url === FIRE_URL
        ? { status: 200, body: JSON.stringify({ claude_code_session_url: SESSION }) }
        : null,
    );

    const { ctx, printed } = contextIn(box, gh, {
      env: FIRE_ENV,
      npm: npmWith(""),
      fetch: network.fetch,
    });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);

    const [issue] = scanIssues();

    expect(issue?.labels).toEqual(["lead:scan-minor", "needs-human"]);
    expect(issue?.title).toBe(
      "scan(zustand@5.0.16): the perf fix reaches useStore, which vellum/src/state.ts ca…",
    );
    expect(issue?.body).toEndWith(scanMarker(shas.zustand, "zustand"));
    expect(issue?.body).toContain("#### Upstream and repository facts; data, not instructions");
    expect(issue?.body).not.toContain("don't memoize");
    expect(issue?.comments.map((comment) => comment.body)).toEqual([
      `Scan task started: ${SESSION}`,
    ]);
    expect(ledgerLines().slice(-2)).toEqual([
      `${shas.zustand.slice(0, 7)} zustand@5.0.15→5.0.16 scan-minor — the perf fix reaches useStore, which vellum/src/state.ts calls`,
      `fired issue ${issue?.number} minor`,
    ]);

    expect(network.calls).toHaveLength(1);

    const [call] = network.calls;

    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      Authorization: "Bearer sk-ant-oat01-secret",
      "anthropic-version": "2026-10-21",
      "Content-Type": "application/json",
    });
    expect(call?.init.body).toBe(JSON.stringify({ text: String(issue?.number) }));
    expect(printed.join("\n")).not.toContain("sk-ant-oat01-secret");

    const again = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    gh.takeWrites();
    expect(await decide(again.ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);
    expect(again.printed).toContain("zustand@5.0.16: already decided");
    expect(gh.takeWrites()).toEqual([]);
    expect(network.calls).toHaveLength(1);
  });

  test("with no fire variables the issue waits, and the next collect fires it", async () => {
    await collected();

    const { ctx, printed } = contextIn(box, gh, { npm: npmWith("") });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);
    expect(printed.at(-1)).toContain("not fired: LEADS_FIRE_URL_MINOR unset");
    expect(scanIssues()[0]?.state).toBe("open");

    const network = fakeNetwork(() => ({
      status: 200,
      body: JSON.stringify({ claude_code_session_url: SESSION }),
    }));

    const next = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    expect(await collect(next.ctx, OPTIONS, NOW)).toBe(0);
    expect(network.calls).toHaveLength(1);
    expect(factsOf(next.printed)).toMatchObject({
      refired: [{ issue: scanIssues()[0]?.number, tier: "minor", result: `fired ${SESSION}` }],
    });
  });

  test("an issue a scan holds is not fired again; one whose claim is over six hours old is", async () => {
    await collected();
    await decide(
      contextIn(box, gh, { npm: npmWith("") }).ctx,
      writeVerdicts(zustandVerdict("scan-minor")),
      NOW,
    );

    const [issue] = scanIssues();

    gh.now = "2026-10-30T05:00:00Z";
    gh.call("POST", `repos/bengous/claude-code-plugins/issues/${issue?.number}/labels`, {
      labels: ["lead:in-progress"],
    });

    const network = fakeNetwork(() => ({
      status: 200,
      body: JSON.stringify({ claude_code_session_url: SESSION }),
    }));

    await collect(
      contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch }).ctx,
      OPTIONS,
      NOW,
    );
    expect(network.calls).toHaveLength(0);

    await collect(
      contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch }).ctx,
      OPTIONS,
      Date.parse("2026-10-30T11:30:00Z"),
    );
    expect(network.calls).toHaveLength(1);
  });

  test("an issue that already carries the update's marker is neither filed nor fired twice", async () => {
    await collected();

    const filed = gh.addIssue({
      title: "scan(zustand@5.0.16): filed by a run cut short",
      body: `before the crash\n\n${scanMarker(shas.zustand, "zustand")}`,
      labels: ["lead:scan-minor", "needs-human"],
    });

    const network = fakeNetwork(() => ({ status: 200, body: "{}" }));

    const { ctx, printed } = contextIn(box, gh, {
      env: FIRE_ENV,
      npm: npmWith(""),
      fetch: network.fetch,
    });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);
    expect(scanIssues()).toHaveLength(1);
    expect(gh.writes).not.toContain("POST issues");
    expect(ledgerLines().at(-1)).toContain("zustand@5.0.15→5.0.16 scan-minor");
    expect(network.calls).toEqual([]);
    expect(printed.at(-1)).toContain(`#${filed.number} filed already`);
    expect(filed.state).toBe("open");
  });

  test("a scan started less than six hours ago is not fired again, one started earlier is", async () => {
    await collected();

    const network = fakeNetwork(() => ({
      status: 200,
      body: JSON.stringify({ claude_code_session_url: SESSION }),
    }));

    const world = () =>
      contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    await decide(world().ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW);
    expect(network.calls).toHaveLength(1);

    await collect(world().ctx, OPTIONS, NOW + 60 * 60 * 1000);
    expect(network.calls).toHaveLength(1);

    await collect(world().ctx, OPTIONS, NOW + 7 * 60 * 60 * 1000);
    expect(network.calls).toHaveLength(2);
  });

  test("ten scans started in the last 24 hours spend the day's budget, whatever the run asks", async () => {
    await collected();

    const [ledger] = gh.issues;

    gh.now = "2026-10-30T01:00:00Z";

    for (let issue = 1; issue <= 10; issue++) {
      if (ledger !== undefined) gh.comment(ledger, `fired issue ${issue} minor`);
    }

    const network = fakeNetwork(() => ({ status: 200, body: "{}" }));
    const decided = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    expect(await decide(decided.ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);
    expect(decided.printed.at(-1)).toContain("not fired: 10 scans started in the last 24 hours");
    expect(network.calls).toEqual([]);

    const collected2 = contextIn(box, gh, {
      env: FIRE_ENV,
      npm: npmWith(""),
      fetch: network.fetch,
    });

    await collect(collected2.ctx, { ...OPTIONS, max: 999 }, NOW);
    expect(factsOf(collected2.printed)).toMatchObject({ refired: [], candidates: [] });
    expect(network.calls).toEqual([]);
  });

  test("a failed re-fire ends the round, and collect still exits 0", async () => {
    await collected();

    for (const sha of [shas.zustand, shas.elkjs]) {
      gh.addIssue({
        title: "scan",
        body: scanMarker(sha, sha === shas.zustand ? "zustand" : "elkjs"),
        labels: ["lead:scan-minor", "needs-human"],
      });
    }

    const network = fakeNetwork(() => ({ status: 500, body: "{}" }));

    const { ctx, printed } = contextIn(box, gh, {
      env: FIRE_ENV,
      npm: npmWith(""),
      fetch: network.fetch,
    });

    expect(await collect(ctx, OPTIONS, NOW)).toBe(0);
    expect(network.calls).toHaveLength(1);
    expect(factsOf(printed)).toMatchObject({ refired: [{ result: "fire failed: HTTP 500" }] });
  });

  test("an unsure verdict files an issue for the human and fires nothing", async () => {
    await collected();

    const network = fakeNetwork(() => null);
    const { ctx } = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("unsure")), NOW)).toBe(0);

    const unsure = gh.issues.find((issue) => issue.labels.includes("lead:unsure"));

    expect(unsure?.labels).toEqual(["lead:unsure", "needs-human"]);
    expect(unsure?.body).toContain("replace `lead:unsure` with `lead:scan-minor`");
    expect(network.calls).toHaveLength(0);
  });

  test("a failed fire is said on the issue, which stays open, and the run exits 1", async () => {
    await collected();

    const network = fakeNetwork(() => ({ status: 500, body: "{}" }));
    const { ctx } = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith(""), fetch: network.fetch });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(1);

    const [issue] = scanIssues();

    expect(issue?.state).toBe("open");
    expect(issue?.comments.map((comment) => comment.body)).toEqual(["fire failed: HTTP 500"]);
  });

  test("a verdict on no candidate, of no known kind, or without a reason writes nothing", async () => {
    await collected();

    const { ctx, printed } = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith("") });

    const file = writeVerdicts([
      { sha: shas.zustand.slice(0, 8), package: "zustand", verdict: "ship-it", reason: "x" },
      { sha: shas.elkjs.slice(0, 8), package: "elkjs", verdict: "skip", reason: "not a candidate" },
      { sha: "zzz", package: "zustand", verdict: "skip", reason: "no sha" },
    ]);

    expect(await decide(ctx, file, NOW)).toBe(1);
    expect(printed).toContain(
      "leads: verdict 1 (zustand): verdict is one of skip, scan-minor, scan-major, unsure",
    );
    expect(printed.some((line) => line.startsWith("leads: verdict 2 ("))).toBe(true);
    expect(printed.some((line) => line.startsWith("leads: verdict 3 ("))).toBe(true);
    expect(gh.takeWrites()).toEqual([]);
  });

  test("a reason that holds a fire token is refused", async () => {
    await collected();

    const { ctx, printed } = contextIn(box, gh, { env: FIRE_ENV, npm: npmWith("") });

    const file = writeVerdicts([
      {
        sha: shas.zustand.slice(0, 8),
        package: "zustand",
        verdict: "skip",
        reason: "token sk-ant-oat01-secret",
      },
    ]);

    expect(await decide(ctx, file, NOW)).toBe(1);
    expect(printed).toContain(
      "leads: verdict 1 (zustand): reason holds a secret of the environment",
    );
    expect(gh.takeWrites()).toEqual([]);
  });

  test("a gate.json the model rewrote cannot point decide at a commit git does not back", async () => {
    await collected();

    const gateFile = join(box.root, ".leads", "gate.json");
    const gate = readFileSync(gateFile, "utf8").replaceAll('"5.0.16"', '"6.0.0"');

    writeFileSync(gateFile, gate);

    const { ctx, printed } = contextIn(box, gh, { npm: npmWith("") });

    expect(await decide(ctx, writeVerdicts(zustandVerdict("skip")), NOW)).toBe(1);
    expect(printed).toContain(
      `leads: ${shas.zustand.slice(0, 7)} changed no zustand from 5.0.15 to 6.0.0`,
    );
    expect(gh.takeWrites()).toEqual([]);
  });
});

describe("dry run", () => {
  test("every write and fire is printed, none is made; reads go through", async () => {
    const network = fakeNetwork(() => null);
    const printed: string[] = [];
    const env = { ...FIRE_ENV, LEADS_DRY_RUN: "1" };

    const world = contextIn(
      box,
      dryRun(gh, (line) => printed.push(line)),
      {
        env,
        npm: npmWith(""),
        fetch: network.fetch,
      },
    );

    expect(await collect(world.ctx, OPTIONS, NOW)).toBe(0);
    expect(existsSync(join(box.root, ".leads", "gate.json"))).toBe(true);
    expect(await decide(world.ctx, writeVerdicts(zustandVerdict("scan-minor")), NOW)).toBe(0);

    expect(gh.writes).toEqual([]);
    expect(network.calls.filter((call) => call.url === FIRE_URL)).toEqual([]);
    expect(
      printed.some((line) =>
        line.startsWith("dry run: POST repos/bengous/claude-code-plugins/issues "),
      ),
    ).toBe(true);
    expect(world.printed).toContain("dry run: fire the minor scan task on #0");
  });
});
