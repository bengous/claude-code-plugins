import type { ChannelEntry } from "../workshop/channel.ts";
import type { Version } from "../workshop/paths.ts";
import { parseFinalDir, parseVersion } from "../workshop/paths.ts";
import type { Carried, Samples, Transitions } from "../workshop/rows.ts";
import { naming } from "../workshop/rows.ts";
import type { Effect, Outcome, PlanText, Workflow } from "../workshop/workflow.ts";
import { planExists, SAMPLE_AT, unchanged } from "../workshop/workflow.ts";
import type { PlanWorkspace } from "../workshop/workspace.ts";
import { batchFile, PLAN_FILE, projectPath, versionFile } from "../workshop/workspace.ts";
import type { ReviewEvents, ReviewPlugs } from "./contract.ts";
import { decideOn } from "./review.ts";

/**
 * The review's part of the workflow: the versions Claude records and the reviewer's edit makes,
 * the batches a Send writes, the approval, and `plan.md` written. It has no region of its own: it
 * moves the workflow's workspace and `plan.md`, which the machine and every part read.
 */

export const REVIEW: ReviewPlugs["id"] = "review";

function versionAfter(workspace: PlanWorkspace): Version {
  const after = parseVersion(workspace.kind === "drafting" ? 1 : workspace.version + 1);

  if (!after.ok) throw new Error(after.error);

  return after.value;
}

/** The version a Send's or an approval's edit names, `""` for none, is no longer under review. */
function isStale(w: Workflow, edit: string): boolean {
  const { workspace } = w;

  return edit !== "" && (workspace.kind !== "inReview" || edit !== String(workspace.version));
}

function writeFile(file: string, text: string): Effect {
  return { kind: "writeFile", owner: REVIEW, file, text };
}

// The guards the rows of `contract.ts` are built from, each stating the fields it reads.

export const planIsAbsent = (w: Workflow): boolean => !planExists(w);

export const noVersionUnderReview = (w: Workflow): boolean => w.workspace.kind === "drafting";

export const planChangedSinceTheVersion = (w: Workflow): boolean =>
  w.workspace.kind === "inReview" && w.planText === "pending";

export const { editsAnotherVersion, namesWhatTheDraftLost, namesPlanCommentsWithoutTheEdit } =
  naming({
    editsAnotherVersion: (w: Workflow, input: { readonly edit: string }): boolean =>
      isStale(w, input.edit),
    namesWhatTheDraftLost: (_w: Workflow, input: { readonly names: string }): boolean =>
      input.names === "changed",
    namesPlanCommentsWithoutTheEdit: (
      w: Workflow,
      input: { readonly edit: string; readonly names: string },
    ): boolean =>
      w.workspace.kind === "inReview" && input.edit === "" && input.names === "withoutEdit",
  });

// The transitions.

/** `gateVersion`'s logic: a text the version lacks, or a Send on it, records the next one; `keep` never records the same text. */
function record(w: Workflow, input: Carried<ReviewEvents, "record">): Outcome {
  const { workspace } = w;

  if (workspace.kind === "approved") return unchanged(w);

  const kept =
    workspace.kind === "inReview" &&
    w.planText === "none" &&
    (input.unchanged === "keep" || workspace.batches === 0);

  if (kept) return unchanged(w);

  const recorded: PlanWorkspace = {
    kind: "inReview",
    dir: workspace.dir,
    version: versionAfter(workspace),
    batches: 0,
    finalizeError: null,
  };

  return {
    workflow: { ...w, planText: "none", workspace: recorded },
    effects: [{ kind: "recordVersion" }],
  };
}

/** The reviewer's edit is the next version, `plan.md` first, as a Send writes it. */
function sendEdit(w: Workflow, input: Carried<ReviewEvents, "sendEdit">): Outcome {
  const { workspace } = w;

  if (workspace.kind !== "inReview") return unchanged(w);
  const version = versionAfter(workspace);
  const { text } = input;

  return {
    workflow: { ...w, planText: "none", workspace: { ...workspace, version, batches: 0 } },
    effects: [writeFile(PLAN_FILE, text), writeFile(versionFile(version), text)],
  };
}

/** The batch, numbered after the Sends on its version, then its entry: the Send's commit point. */
function send(w: Workflow, input: Carried<ReviewEvents, "send">): Outcome {
  const { workspace } = w;

  if (workspace.kind === "approved") return unchanged(w);
  const version = workspace.kind === "drafting" ? null : workspace.version;
  const batches = workspace.batches + 1;
  const file = batchFile(version, batches);
  const sent: ChannelEntry = { kind: "sent", file: projectPath(`${workspace.dir}${file}`) };

  return {
    workflow: { ...w, workspace: { ...workspace, batches } },
    effects: [writeFile(file, input.text), { kind: "channel", entry: sent }],
  };
}

/**
 * The reviewer's edit as the next version, then the directory approved under the name the route
 * resolved (`input.dir`); the parts close theirs by reaction, and the entry comes last. It names
 * the notes file this approval writes, or the one a first attempt left (`input.noted`).
 */
function approve(w: Workflow, input: Carried<ReviewEvents, "approve">): Outcome {
  const { workspace } = w;

  if (workspace.kind !== "inReview") return unchanged(w);
  const { text } = input;
  const edit = input.edit === "" ? null : { version: workspace.version, text };
  const decided = decideOn(workspace, null, { kind: "approve", edit, notes: input.notes });
  const dir = parseFinalDir(input.dir);

  if (decided.kind === "refused") throw new Error("an approval the rows passed was refused");

  if (!dir.ok) throw new Error(dir.error);
  const { version, notes } = decided;

  const edited =
    decided.edit === null
      ? []
      : [writeFile(PLAN_FILE, text), writeFile(versionFile(version), text)];

  const approved: PlanWorkspace = {
    kind: "approved",
    dir: dir.value,
    version,
    notes: notes !== null || input.noted === "true",
  };

  return {
    workflow: { ...w, planText: "none", workspace: approved },
    effects: [...edited, { kind: "approveDirectory", dir: dir.value, notes: notes?.text ?? null }],
  };
}

function planTextIn(plan: string): PlanText {
  if (plan === "none" || plan === "pending" || plan === "absent") return plan;

  throw new Error(`planWritten carries none, pending or absent, not ${plan}`);
}

/** What the watcher read of `plan.md` against the last version. */
function planWritten(w: Workflow, input: Carried<ReviewEvents, "planWritten">): Outcome {
  return { workflow: { ...w, planText: planTextIn(input.plan) }, effects: [] };
}

export const TRANSITIONS: Transitions<ReviewEvents> = {
  record,
  sendEdit,
  send,
  approve,
  planWritten,
};

// The inputs `refusedNow` and the proof of the table (`proof.ts`) try.

const EDITED = "# Plan\n\nThe reviewer's edit.\n";

const FINAL = "plans/2026-09-26/the-plan/";

export const SAMPLES: Samples<ReviewEvents> = {
  record: [{ unchanged: "keep" }, { unchanged: "record" }],
  sendEdit: [
    { edit: "1", text: EDITED },
    { edit: "2", text: EDITED },
  ],
  send: [
    { parts: "true", edit: "", names: "held", comments: "false", text: "## Grill\n" },
    { parts: "false", edit: "", names: "held", comments: "true", text: "## Comments\n" },
    { parts: "false", edit: "", names: "changed", comments: "true", text: "## Comments\n" },
    { parts: "false", edit: "", names: "withoutEdit", comments: "true", text: "## Comments\n" },
    { parts: "false", edit: "1", names: "held", comments: "true", text: "## Comments\n" },
  ],
  approve: [
    { confirmed: "", edit: "", text: "", notes: "", dir: FINAL, noted: "false", at: SAMPLE_AT },
    {
      confirmed: "",
      edit: "1",
      text: "# Plan\n\nApproved as edited.\n",
      notes: "Ship it.",
      dir: FINAL,
      noted: "false",
      at: SAMPLE_AT,
    },
  ],
  planWritten: [{ plan: "pending" }, { plan: "none" }, { plan: "absent" }],
};
