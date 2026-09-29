import { describe, expect, test } from "bun:test";

import type {
  Bodies,
  ErasedSliceContext,
  ServerHalf,
  SliceContext,
  SliceDispatched,
} from "../../runtime/extension.ts";
import type { HooksHalf } from "../../runtime/hooks/extension.ts";
import { engineExtension } from "../../runtime/hooks/slice.ts";
import { serverExtension } from "../../runtime/server/slice.ts";
import { parseWipDir } from "../../workshop/paths.ts";
import { core, defineSlice } from "../../workshop/plugs.ts";
import type { Reactions } from "../../workshop/rows.ts";
import { rows } from "../../workshop/rows.ts";
import type { Outcome, Workflow } from "../../workshop/workflow.ts";
import { unchanged } from "../../workshop/workflow.ts";
import type { ProposalPlugs } from "../proposal/contract.ts";
import { hooks as stepHooks } from "../proposal/hooks.ts";
import { server as stepServer } from "../proposal/server.ts";
import type { GrillHears, GrillPlugs } from "./contract.ts";
import { SLICE } from "./contract.ts";
import { grillIsOpen, REACTIONS, regionOf } from "./grill.ts";
import { hooks } from "./hooks.ts";
import { BODIES } from "./parse.ts";
import { server } from "./server.ts";

/**
 * What the grill's plugs make a compile error beyond the step's (`step/contract.spec.ts`): the
 * code under `@ts-expect-error` is what must not compile, and the line after it runs, to say what
 * that code would do.
 */

const DIR = parseWipDir("plans/2026-09-28/wip-3c9e11d0/");

if (!DIR.ok) throw new Error(DIR.error);

const W: Workflow = {
  workspace: { kind: "drafting", dir: DIR.value, batches: 0 },
  planText: "absent",
  regions: [regionOf(null)],
};

const DISPATCHED: SliceDispatched = {
  verdict: { kind: "allow" },
  workflow: W,
  effects: [],
  appended: [],
};

/** A `dispatch` that records each event with the sender its caller named. */
function recording(sent: string[]): SliceContext<GrillPlugs>["dispatch"] {
  const dispatch: ErasedSliceContext["dispatch"] = (event, _input, by) => {
    sent.push(`${event} ${by ?? "(none)"}`);

    return Promise.resolve(DISPATCHED);
  };

  return dispatch;
}

/** A `start` that records the id it was asked to open. */
function starting(opened: string[]): SliceContext<ProposalPlugs>["start"] {
  return (id) => {
    opened.push(id);

    return Promise.resolve("");
  };
}

const { refuse } = rows(SLICE);

const readsProposal = (
  _w: Workflow,
  input: { readonly move: string | undefined; readonly proposal: string | undefined },
): boolean => input.move === "grill" && input.proposal !== undefined;

describe("an event with several senders is sent as one of them, named at the call", () => {
  const TYPING = { reason: "stop", grill: "" };

  test("endGrill sent with no sender named does not compile: the adapter would throw", async () => {
    const sent: string[] = [];

    // @ts-expect-error -- `endGrill` is sent by the reviewer or the engine: the route names which.
    await recording(sent)("endGrill", TYPING);

    expect(sent).toEqual(["endGrill (none)"]);
  });

  test("endGrill sent by one who does not send it does not compile", async () => {
    const sent: string[] = [];

    // @ts-expect-error -- Claude does not end a grill.
    await recording(sent)("endGrill", TYPING, "claude");

    expect(sent).toEqual(["endGrill claude"]);
  });

  test("an event with one sender takes none at the call: the contract names it", async () => {
    const sent: string[] = [];

    // @ts-expect-error -- `askQuestion` is Claude's alone.
    await recording(sent)("askQuestion", { q: "[]" }, "claude");

    expect(sent).toEqual(["askQuestion claude"]);
  });
});

describe("the events the grill hears are the others' as their contracts type them", () => {
  test("a row on an event the grill neither owns nor hears does not compile", () => {
    // @ts-expect-error -- the grill hears the step's `answerProposal`, not its `propose`.
    const row = refuse("propose", "no", grillIsOpen, 409, "no");

    expect(String(row.event)).toBe("propose");
  });

  test("a guard on the step's answer reading a field the step's contract does not give it does not compile", () => {
    // @ts-expect-error -- `answerProposal` carries id, answer, move, subject and opened: no `proposal`.
    const row = refuse("answerProposal", "no", readsProposal, 409, "no");

    expect(row.when(W, { move: "grill" })).toBe(false);
  });

  test("a reaction to an event the grill does not hear does not compile: it would never run", () => {
    // @ts-expect-error -- the grill hears answerProposal, send and approve.
    const reactions: Reactions<GrillHears> = { ...REACTIONS, propose: unchanged };

    expect(Object.keys(reactions)).toContain("propose");
  });

  test("a reaction reading a field its event does not carry does not compile", () => {
    const reactions: Reactions<GrillHears> = {
      ...REACTIONS,
      answerProposal: (w, input): Outcome =>
        // @ts-expect-error -- the step's answer carries no `proposal`.
        input.proposal === undefined ? unchanged(w) : unchanged(w),
    };

    expect(reactions.answerProposal).toBeDefined();
  });

  test("a core event heard is named, and a name the core has not does not compile", () => {
    const declared = defineSlice({
      id: "grill",
      // @ts-expect-error -- the core's events are record, sendEdit, send, approve and planWritten.
      hears: { gate: core },
    });

    expect(Object.keys(declared.hears)).toEqual(["gate"]);
  });
});

describe("the hooks half denies what its plugs deny, and no other", () => {
  test("a hooks half without the refusal its plugs declare does not compile: AskUserQuestion would reach the terminal", () => {
    const { refuses: _refuses, ...others } = hooks;
    // @ts-expect-error -- the plugs deny `AskUserQuestion`.
    const half: HooksHalf<GrillPlugs> = others;

    expect(engineExtension(half).refuses).toBeUndefined();
  });

  test("a refusal of a tool the plugs do not deny does not compile", () => {
    const half: HooksHalf<GrillPlugs> = {
      ...hooks,
      // @ts-expect-error -- the plugs deny `AskUserQuestion` alone.
      refuses: { AskUserQuestion: "the page", Bash: "no shell" },
    };

    expect(Object.keys(engineExtension(half).refuses ?? {})).toContain("Bash");
  });

  test("a hooks half whose plugs deny nothing takes no refusal", () => {
    // @ts-expect-error -- the step's plugs deny nothing.
    const half: HooksHalf<ProposalPlugs> = { ...stepHooks, refuses: { Bash: "no shell" } };

    expect(engineExtension(half).refuses).toEqual({ Bash: "no shell" });
  });
});

describe("what opens the grill is typed by its plugs, and the opener names them", () => {
  test("a grill server half without its start does not compile: a grill move would open with no word to Claude", () => {
    const { start: _start, ...others } = server;
    // @ts-expect-error -- the plugs say the grill is opened with `{ subject }`.
    const half: ServerHalf<GrillPlugs> = others;

    expect(serverExtension(half).start).toBeUndefined();
  });

  test("a step server half with a start does not compile: nothing opens the step", () => {
    // @ts-expect-error -- the step's plugs open it with nothing.
    const half: ServerHalf<ProposalPlugs> = { ...stepServer, start: server.start };

    expect(half.start).toBeDefined();
  });

  test("opening the grill without naming its plugs does not compile", async () => {
    const opened: string[] = [];

    // @ts-expect-error -- `start` takes the opened slice's plugs as its type argument.
    await starting(opened)("grill", { subject: "auth" });

    expect(opened).toEqual(["grill"]);
  });

  test("opening the grill with another input than its plugs' does not compile", async () => {
    const opened: string[] = [];

    // @ts-expect-error -- the grill opens on `{ subject: string }`.
    await starting(opened)<GrillPlugs>("grill", { subject: 7 });

    expect(opened).toEqual(["grill"]);
  });

  test("opening another slice under the grill's plugs does not compile", async () => {
    const opened: string[] = [];

    // @ts-expect-error -- `GrillPlugs` names the slice `grill`.
    await starting(opened)<GrillPlugs>("step", { subject: "auth" });

    expect(opened).toEqual(["step"]);
  });
});

describe("the grill's part of the Send carries what its plugs say", () => {
  test("a grill server half without its part does not compile: the Send would leave the round open", () => {
    const { part: _part, ...others } = server;
    // @ts-expect-error -- the plugs say the grill's part carries its `Typing`.
    const half: ServerHalf<GrillPlugs> = others;

    expect(serverExtension(half).part).toBeUndefined();
  });

  test("a part carrying another input than its plugs' does not compile", () => {
    const half: ServerHalf<GrillPlugs> = {
      ...server,
      // @ts-expect-error -- the part carries a `Typing`, not a text.
      part: () => Promise.resolve({ kind: "part", text: "", typed: (typed) => typed, input: "" }),
    };

    expect(half.part).toBeDefined();
  });
});

describe("a GET reads the query its plugs declare, parsed", () => {
  test("a blocks handler reading a query field its plugs do not declare does not compile", () => {
    const half: ServerHalf<GrillPlugs> = {
      ...server,
      routes: {
        ...server.routes,
        // @ts-expect-error -- `GET blocks` reads `file` alone.
        "GET blocks": (_context, query) => Promise.resolve({ answer: query.name ?? [] }),
      },
    };

    expect(half.routes["GET blocks"]).toBeDefined();
  });

  test("the parsers without the blocks query's do not compile: the route would read an unparsed query", () => {
    const { "GET blocks": _blocks, ...others } = BODIES;
    // @ts-expect-error -- `GET blocks` reads a query, which its parser reads first.
    const bodies: Bodies<GrillPlugs["server"]> = others;

    expect(Object.keys(bodies)).not.toContain("GET blocks");
  });
});
