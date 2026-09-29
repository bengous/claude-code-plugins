import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChannelEntry } from "../../workshop/channel.ts";
import type { FinalDir } from "../../workshop/paths.ts";
import { parseFinalDir, parseWipDir } from "../../workshop/paths.ts";
import type { Effect, EventInput, JournalLine } from "../../workshop/workflow.ts";
import { SAMPLE_AT } from "../../workshop/workflow.ts";
import type { EffectPorts } from "./effects.ts";
import { EffectFailed, interpret } from "./effects.ts";
import { Review } from "./review.ts";
import { serverExtensions } from "./slices.ts";

const WIP = "plans/2026-09-26/wip-4c2a9d93/";

const FINAL = "plans/2026-09-26/the-plan/";

function finalDir(): FinalDir {
  const dir = parseFinalDir(FINAL);

  if (!dir.ok) throw new Error(dir.error);

  return dir.value;
}

/** Fake ports, and each call they took in order. */
type Logged = { readonly calls: string[]; readonly ports: EffectPorts };

/** Fake ports that log each call, and fail the calls `failing` names. */
function ports(failing: readonly string[] = [], renamed = true): Logged {
  const calls: string[] = [];

  const call = (what: string): Promise<void> => {
    calls.push(what);

    return failing.includes(what)
      ? Promise.reject(new Error(`${what} refused`))
      : Promise.resolve();
  };

  return {
    calls,
    ports: {
      recordVersion: () => call("recordVersion"),
      writeFile: (file) => call(`write ${file}`),
      appendFile: (file) => call(`append ${file}`),
      exists: (file) => Promise.resolve(file === "old.md"),
      removeFile: (file) => call(`remove ${file}`),
      relay: async () => {
        await call("relay");

        return 7;
      },
      returnToCall: (callId, seq) => void calls.push(`return ${callId} ${seq}`),
      approveDirectory: async () => {
        await call("approveDirectory");

        return renamed;
      },
      journal: () => call("journal"),
      log: (text) => void calls.push(`log ${text.split(":")[0] ?? ""}`),
    },
  };
}

const LINE: JournalLine = { actor: "engine", event: "e", input: {}, verdict: "allow" };

const ENTRY: ChannelEntry = { kind: "text", from: "core", text: "told" };

function write(file: string): Effect {
  return { kind: "writeFile", owner: "core", file, text: "x" };
}

describe("interpret", () => {
  test("a write that fails before the step's entry fails the step, naming the effect", async () => {
    const { ports: failing } = ports(["write a.md"]);

    const failure = await interpret([write("a.md"), { kind: "channel", entry: ENTRY }], failing)
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(EffectFailed);
    expect(String(failure)).toContain("writeFile failed");
  });

  test("an entry that fails removes the files the step created, never one that was there", async () => {
    const { calls, ports: failing } = ports(["relay"]);
    const effects = [write("new.md"), write("old.md"), { kind: "channel", entry: ENTRY } as const];

    await expect(interpret(effects, failing)).rejects.toThrow("channel failed");
    expect(calls).toEqual(["write new.md", "write old.md", "relay", "remove new.md"]);
  });

  test("past the entry a failure is logged, the rest runs, and a call claims that entry", async () => {
    const { calls, ports: failing } = ports(["append t.md"]);

    const effects: Effect[] = [
      { kind: "channel", entry: ENTRY },
      { kind: "appendFile", owner: "grill", file: "t.md", text: "x" },
      { kind: "returnToCall", call: "p1", text: "told" },
    ];

    expect(await interpret(effects, failing)).toEqual({ appended: [7], stopped: false });
    expect(calls).toEqual([
      "relay",
      "append t.md",
      "log appendFile failed after the step was taken",
      "return p1 7",
    ]);
  });

  test("a rename that fails stops the rest, but the journal line", async () => {
    const { calls, ports: unmoved } = ports([], false);

    const effects: Effect[] = [
      { kind: "approveDirectory", dir: finalDir(), notes: null },
      write("step.json"),
      { kind: "channel", entry: ENTRY },
      { kind: "journal", line: LINE },
    ];

    expect(await interpret(effects, unmoved)).toEqual({ appended: [], stopped: true });
    expect(calls).toEqual(["approveDirectory", "journal"]);
  });

  test("a journal line that fails is logged and fails nothing", async () => {
    const { calls, ports: failing } = ports(["journal"]);

    expect(await interpret([{ kind: "journal", line: LINE }], failing)).toEqual({
      appended: [],
      stopped: false,
    });
    expect(calls).toEqual(["journal", "log a journal line was not written"]);
  });
});

/** A server's review on a fresh working directory, its channel open. */
async function reviewing(
  plan: string | null = "# The plan\n",
): Promise<{ readonly review: Review; readonly root: string }> {
  const root = mkdtempSync(join(tmpdir(), "vellum-effects-"));
  mkdirSync(join(root, WIP, ".review"), { recursive: true });

  if (plan !== null) writeFileSync(join(root, WIP, "plan.md"), plan);
  const workdir = parseWipDir(WIP);

  if (!workdir.ok) throw new Error(workdir.error);

  const review = new Review({
    project: root,
    workdir: workdir.value,
    extensions: serverExtensions,
  });

  await review.openChannel();

  return { review, root };
}

/**
 * One step dispatched and interpreted, then the workflow read back off the disk and the server's
 * memory: it is the workflow `next` answered.
 */
async function roundTrip(
  review: Review,
  event: string,
  input: EventInput,
): Promise<readonly Effect["kind"][]> {
  const stepped = await review.context.dispatch(event, input, "reviewer");

  expect(stepped.verdict).toEqual({ kind: "allow" });
  expect(await review.context.workflow()).toEqual(stepped.workflow);

  return stepped.effects.map(({ kind }) => kind);
}

const MOCKUP = { kind: "mockup", screen: "login" };

const PROPOSAL = JSON.stringify({ reason: "A screen.", moves: [MOCKUP], recommended: 0 });

const PICK = {
  id: "p1",
  answer: JSON.stringify({ kind: "move", move: MOCKUP }),
  move: "mockup",
  subject: "",
  opened: "",
};

describe("a step read back is the workflow next answered (§ 5.9)", () => {
  test("recordVersion: plan.md is the next version, and plan.md no longer waits", async () => {
    const { review, root } = await reviewing();

    expect(await roundTrip(review, "record", { unchanged: "keep" })).toContain("recordVersion");
    expect(readFileSync(join(root, WIP, ".review/v1.md"), "utf8")).toBe("# The plan\n");
  });

  test("writeFile: a proposal lands in step.json, its call waiting", async () => {
    const { review, root } = await reviewing();

    expect(await roundTrip(review, "propose", { id: "p1", proposal: PROPOSAL })).toContain(
      "writeFile",
    );
    expect(existsSync(join(root, WIP, ".review/step.json"))).toBe(true);
  });

  test("writeFile: a run asked lands in reviews.json, whose fields read back in one order", async () => {
    const { review } = await reviewing();
    await roundTrip(review, "record", { unchanged: "keep" });

    expect(await roundTrip(review, "requestReview", { version: "1" })).toContain("writeFile");
  });

  test("appendFile: a round lands in the transcript, its call waiting", async () => {
    const { review } = await reviewing(null);

    const grill = {
      ...PICK,
      id: "",
      move: "grill",
      subject: "auth",
      answer: JSON.stringify({
        kind: "move",
        move: { kind: "grill", subject: "auth", choices: [] },
      }),
    };

    await roundTrip(review, "answerProposal", { ...grill, at: SAMPLE_AT });
    const q = JSON.stringify([["Store", "Which store?", "Redis"]]);

    expect(await roundTrip(review, "askQuestion", { q })).toContain("appendFile");
  });

  test("channel and returnToCall: the pick is an entry, and the call waiting claims it", async () => {
    const { review } = await reviewing(null);
    await roundTrip(review, "propose", { id: "p1", proposal: PROPOSAL });

    expect(await roundTrip(review, "answerProposal", PICK)).toEqual([
      "channel",
      "writeFile",
      "returnToCall",
      "journal",
    ]);
    expect(review.context.returned("p1")).toEqual({
      seq: 1,
      text: "Accepted: a mockup of: login.",
    });
  });

  test("approveDirectory: the plan approved in its final directory, every region closed", async () => {
    const { review, root } = await reviewing();
    await roundTrip(review, "record", { unchanged: "keep" });
    const approval = { confirmed: "", edit: "", text: "", notes: "", dir: FINAL, noted: "false" };

    expect(await roundTrip(review, "approve", approval)).toContain("approveDirectory");
    expect(existsSync(join(root, FINAL, ".review/v1.md"))).toBe(true);
  });

  test("journal: every event judged is a line, a refused one included", async () => {
    const { review, root } = await reviewing(null);
    await review.context.dispatch("record", { unchanged: "keep" }, "claude");
    const [line] = readFileSync(join(root, WIP, ".review/events.jsonl"), "utf8").split("\n");

    expect(JSON.parse(line ?? "")).toMatchObject({
      actor: "claude",
      event: "record",
      verdict: "refuse",
      rule: "no-plan",
      reason: `write plan.md in ${WIP} first`,
    });
  });
});
