import type { Reply, ServerContext, ServerHalf, SliceContext } from "../../core/extension.ts";
import type { PlanWorkspace } from "../../core/protocol.ts";
import { regionIn } from "../../core/server/domain/workflow.ts";
import { projectPath } from "../../core/server/domain/workspace.ts";
import type { GrillPlugs } from "../grill/contract.ts";
import type { Proposed, StepPlugs, StepWaited } from "./contract.ts";
import { RULES, SLICE } from "./contract.ts";
import { BODIES, parseJson, parseStepFile } from "./parse.ts";
import type { StepFile } from "./proposal.ts";
import {
  fileOf,
  lineOf,
  REACTIONS,
  regionOf,
  SAMPLES,
  segmentOf,
  STEP,
  STEP_FILE,
  TRANSITIONS,
} from "./proposal.ts";

type Context = SliceContext<StepPlugs>;

/** Before any event: no row judges a directory the server lost. */
const DIRECTORY_GONE: Reply<never> = {
  refused: { status: 409, reason: "the plan's directory is gone" },
};

/** `null` when the working directory is gone and the server lost its memory: the route answers 409. */
function workspaceIfAny(context: Context): Promise<PlanWorkspace | null> {
  return context.workspace().catch(() => null);
}

/** A file it cannot read reads as no proposal, and says so: nothing it held can be answered. */
async function readStep(
  context: Pick<ServerContext, "workspace" | "readText">,
): Promise<StepFile | null> {
  const { dir } = await context.workspace();
  const text = await context.readText(projectPath(`${dir}${STEP_FILE}`));

  if (text === null) return null;
  const file = parseStepFile(parseJson(text));

  if (file === null) console.error(`${STEP_FILE} is unreadable, read as no proposal: ${text}`);

  return file;
}

/** Where the proposal `id` stands, as `step.json` says it: waiting, answered, dropped and why, or unknown. */
function waitedOn(file: StepFile | null, id: string): StepWaited {
  if (file?.pending?.id === id) return { kind: "open" };

  if (file?.answered?.id === id) {
    return { kind: "answered", seq: file.answered.seq, text: file.answered.text };
  }

  return file?.dropped?.id === id ? { kind: "ended", why: file.dropped.why } : { kind: "gone" };
}

export const server: ServerHalf<StepPlugs> = {
  id: "step",
  bodies: BODIES,
  routes: {
    // In the queue: a step writes step.json before it keeps its wait in memory, and a read between
    // the two would take a proposal Claude's call waits on for a paused one.
    "GET state": async (context) => {
      const region = regionIn(await context.inOrder(() => context.workflow()), STEP);

      return {
        answer: {
          pending: fileOf(region).pending,
          paused: region.state === "open" && region.wait === "paused",
        },
      };
    },

    "POST propose": async (context, proposal) => {
      if ((await workspaceIfAny(context)) === null) return DIRECTORY_GONE;
      const proposed: Proposed = { id: crypto.randomUUID() };
      const input = { id: proposed.id, proposal: JSON.stringify(proposal) };
      const { verdict } = await context.dispatch("propose", input);

      return verdict.kind === "allow" ? { answer: proposed } : { refused: verdict };
    },

    // A repost while Claude's call already waits is a keepalive: no step, no journal line (E4).
    "POST wait": async (context, { id }) => {
      const region = (await context.workflow()).regions.find((one) => one.id === STEP);

      if (region?.state === "open" && region.data.pending === id && region.wait !== "open") {
        await context.dispatch("wait", { id });
      }

      const waited = await context.hold(
        () => context.inOrder(async () => waitedOn(await readStep(context), id)),
        ({ kind }) => kind === "open",
      );

      return { answer: waited };
    },

    // Claude's turn was cut while its call waited: nothing claims the pick now, which goes as a prompt.
    "POST pause": async (context, { id }) => {
      const { verdict } = await context.dispatch("pause", { id });

      return verdict.kind === "allow" ? { answer: { wait: "paused" } } : { refused: verdict };
    },

    // The window's answer settles the proposal waiting, the one it showed or, opened blank, any:
    // a grill it opens holds the review, and a proposal left waiting under it would never end.
    "POST answer": async (context, { id, answer }) => {
      if ((await workspaceIfAny(context)) === null) return DIRECTORY_GONE;
      const move = answer.kind === "own" ? "own" : answer.move.kind;

      const subject =
        answer.kind === "move" && answer.move.kind === "grill" ? answer.move.subject : "";

      const { verdict } = await context.dispatch("answerProposal", async () => ({
        id: id ?? "",
        answer: JSON.stringify(answer),
        move,
        subject,
        opened: move === "grill" ? await context.start<GrillPlugs>("grill", { subject }) : "",
      }));

      return verdict.kind === "allow" ? { answer: null } : { refused: verdict };
    },
  },
  workflow: {
    events: SLICE.events,
    rules: RULES,
    samples: SAMPLES,
    transitions: TRANSITIONS,
    reactions: REACTIONS,
    region: async (context, before) => regionOf(await readStep(context), before),
    segment: segmentOf,
    line: lineOf,
  },
};
