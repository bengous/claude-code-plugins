import type { Reply, ServerContext, ServerHalf, SliceContext } from "../../runtime/extension.ts";
import type { PlanWorkspace } from "../../runtime/protocol.ts";
import { heldWait } from "../../runtime/server/slice.ts";
import { waitedOn } from "../../workshop/waits.ts";
import { regionIn } from "../../workshop/workflow.ts";
import { projectPath } from "../../workshop/workspace.ts";
import type { GrillPlugs } from "../grill/contract.ts";
import type { Proposed, StepPlugs } from "./contract.ts";
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

    "POST wait": (context, { id }) =>
      heldWait(
        context,
        STEP,
        id,
        () => context.dispatch("wait", { id }),
        async () => waitedOn(await readStep(context), id),
      ),

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
