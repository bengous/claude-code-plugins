import { describe, expect, test } from "bun:test";

import type { Answers, HooksContext, HooksHalf, Posted } from "../../runtime/hooks/extension.ts";
import { engineExtension } from "../../runtime/hooks/slice.ts";
import { parseWipDir } from "../../workshop/paths.ts";
import type { EndsWithoutVerdict } from "../../workshop/rows.ts";
import { rows } from "../../workshop/rows.ts";
import type { Workflow } from "../../workshop/workflow.ts";
import type { StepPlugs } from "../proposal/contract.ts";
import { ENDS_WITHOUT_VERDICT, regionOf } from "./agent-review.ts";
import type { ReviewEvents, ReviewPlugs } from "./contract.ts";
import { SLICE } from "./contract.ts";
import { hooks } from "./hooks.ts";
import { parseClosed } from "./parse.ts";

/**
 * What the review's plugs make a compile error that no other slice's suite holds, one test each:
 * the code under `@ts-expect-error` is what must not compile, and the line after it runs, to say
 * what that code would do.
 */

const DIR = parseWipDir("plans/2026-09-28/wip-4e1f0a7c/");

if (!DIR.ok) throw new Error(DIR.error);

const W: Workflow = {
  workspace: { kind: "drafting", dir: DIR.value, batches: 0 },
  planText: "absent",
  regions: [regionOf(null)],
};

const REFUSED: Posted<never> = { ok: false, status: 409, text: "", reason: null };

/** A client's reads, recorded: every route asked, each refused. */
function reading<P extends ReviewPlugs | StepPlugs>(read: string[]): HooksContext<P>["get"] {
  return (route) => {
    read.push(route);

    return Promise.resolve(REFUSED);
  };
}

describe("the hooks half hears a subagent's end, and reads its own server half", () => {
  test("a hooks half without agentAnswered does not compile: the plan reviewer's verdict would reach nobody", () => {
    const { agentAnswered: _answered, ...rest } = hooks;
    // @ts-expect-error -- the plugs declare the listener `agentAnswered`.
    const half: HooksHalf<ReviewPlugs> = rest;

    expect(engineExtension(half).agentAnswered).toBeUndefined();
  });

  test("reading a route the hooks half does not read does not compile: it reads GET state alone", async () => {
    const read: string[] = [];

    // @ts-expect-error -- the hooks half reads `GET state`, and posts `POST close`.
    await reading<ReviewPlugs>(read)("POST close");

    expect(read).toEqual(["POST close"]);
  });

  test("a hooks half whose plugs read nothing reads nothing: the step's client has no route to read", async () => {
    const read: string[] = [];

    // @ts-expect-error -- the step's plugs declare no `gets`.
    await reading<StepPlugs>(read)("GET state");

    expect(read).toEqual(["GET state"]);
  });

  test("a parser of GET state reading another answer does not compile: every stage line would find no run", () => {
    // @ts-expect-error -- `GET state` answers a `ReviewState`, and `parseClosed` reads `{ stopping }`.
    const answers: Answers<ReviewPlugs> = { ...hooks.answers, "GET state": parseClosed };

    expect(JSON.stringify(answers["GET state"]({ stopping: [] }))).toBe('{"stopping":[]}');
  });

  test("a route the hooks half reads that the server does not declare does not compile: nothing would answer it", () => {
    type Stray = Omit<ReviewPlugs, "hooks"> & {
      readonly hooks: Omit<ReviewPlugs["hooks"], "gets"> & {
        readonly gets: ReviewPlugs["hooks"]["gets"] | "GET runs";
      };
    };

    // @ts-expect-error -- the server declares no `GET runs`.
    const half: HooksHalf<Stray> = {
      ...hooks,
      answers: { ...hooks.answers, "GET runs": null },
    };

    expect(Object.keys(half.answers)).toContain("GET runs");
  });
});

describe("a row's words and a hold's end read what the event carries", () => {
  const { refuse } = rows(SLICE);

  test("a reason reading a field its event does not carry does not compile: the refusal would say undefined", () => {
    const row = refuse(
      "reviewStopped",
      "odd",
      () => true,
      409,
      (_w, input) => {
        // @ts-expect-error -- `reviewStopped` carries `seq` alone.
        return `v${input.version}`;
      },
    );

    expect(row.reason(W, { seq: "1" })).toBe("vundefined");
  });

  test("an end without a verdict on an event the review does not own does not compile: the notice would never read it", () => {
    const ends: EndsWithoutVerdict<ReviewEvents> = {
      ...ENDS_WITHOUT_VERDICT,
      // @ts-expect-error -- the review owns no `approve`: the core's approval ends a run.
      approve: () => true,
    };

    expect(Object.keys(ends)).toContain("approve");
  });

  test("an end without a verdict reading a field its event does not carry does not compile", () => {
    const ends: EndsWithoutVerdict<ReviewEvents> = {
      reviewForgotten: (input) => {
        // @ts-expect-error -- `reviewForgotten` carries `seq` alone.
        return input.outcome !== "answer";
      },
    };

    expect(ends.reviewForgotten?.({ seq: "1", at: "" })).toBe(true);
  });
});
