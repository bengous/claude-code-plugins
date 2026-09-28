import type {
  Carried,
  Reactions,
  Read,
  Samples,
  Transitions,
} from "../../core/server/domain/rows.ts";
import { naming } from "../../core/server/domain/rows.ts";
import type { Effect, Outcome, Region, Wait, Workflow } from "../../core/server/domain/workflow.ts";
import { regionIn, SAMPLE_AT, unchanged, withRegion } from "../../core/server/domain/workflow.ts";
import { batchFile, projectPath } from "../../core/server/domain/workspace.ts";
import type { GrillEvents, GrillHears, GrillPlugs, Phase, Typing } from "./contract.ts";
import { ASK_TOOL, grillFile, parseJson, parseQuestions, parseSubject } from "./parse.ts";
import {
  appendAnswer,
  appendEvent,
  appendFooter,
  appendQuestions,
  appendReply,
  header,
  isClosed,
  phaseOf,
  type Relay,
  relaysOf,
  segmentsOf,
} from "./transcript.ts";

/**
 * `grill`'s part of the workflow: the transcript read last. Open, it holds the review, and a
 * question waiting is Claude's call waiting, or paused once the turn that asked it was cut.
 */

export const GRILL: GrillPlugs["id"] = "grill";

/** The transcript with the highest number of the plan's directory, and its text. */
export type Latest = { readonly n: number; readonly doc: string };

const NOTHING_TYPED: Typing = { answers: {}, note: "" };

function waitOf(phase: Phase): Wait | null {
  if (phase === "asking") return "open";

  return phase === "paused" ? "paused" : null;
}

/** Open from its header to its footer; closed, it keeps the number the next grill follows. */
export function regionOf(latest: Latest | null): Region {
  const n = latest?.n ?? 0;

  if (latest === null || isClosed(latest.doc)) return { id: GRILL, state: "closed", data: { n } };
  const { doc } = latest;

  return {
    id: GRILL,
    state: "open",
    holds: `grill ${n} is open`,
    wait: waitOf(phaseOf(doc)),
    data: { n, doc },
  };
}

function latestIn(w: Workflow): Latest {
  const { data } = regionIn(w, GRILL);

  return { n: Number(data.n ?? 0), doc: String(data.doc ?? "") };
}

// The guards the rows of `contract.ts` are built from, each stating the fields it reads.

export const grillIsOpen = (w: Workflow): boolean => regionIn(w, GRILL).state === "open";

export const noGrillIsOpen = (w: Workflow): boolean => !grillIsOpen(w);

export const { namesNoSubject } = naming({
  namesNoSubject: (_w: Workflow, input: { readonly subject: string | undefined }): boolean =>
    parseSubject({ subject: input.subject }) === null,
});

/** The open transcript by its file, as a refusal names it. */
export const openTranscript = (w: Workflow): string => `${grillFile(latestIn(w).n)} is open`;

// The transitions.

/** A write that only adds to the file appends; one that inserts, as a turn's text before a reply sent meanwhile, rewrites it. */
function fileEffect(file: string, before: string, after: string): Effect {
  return after.startsWith(before)
    ? { kind: "appendFile", owner: GRILL, file, text: after.slice(before.length) }
    : { kind: "writeFile", owner: GRILL, file, text: after };
}

function dateOf(at: string | undefined): Date {
  const date = new Date(at ?? "");

  if (Number.isNaN(date.getTime())) throw new Error(`not a time: ${at ?? ""}`);

  return date;
}

/** The open transcript through `write`; a grill closed, or a write that adds nothing, leaves all as it is. */
function rewritten(w: Workflow, write: (doc: string) => string): Outcome {
  if (!grillIsOpen(w)) return unchanged(w);
  const { n, doc } = latestIn(w);
  const after = write(doc);

  if (after === doc) return unchanged(w);

  return {
    workflow: withRegion(w, regionOf({ n, doc: after })),
    effects: [fileEffect(grillFile(n), doc, after)],
  };
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser: an input carries the reviewer's typing as the JSON the route wrote from the draft, read back here as `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Nothing typed when the input carries none: every question open takes its recommendation. */
function typingOf(json: string | undefined): Typing {
  if (json === undefined || json === "") return NOTHING_TYPED;
  const value = parseJson(json);

  if (!isRecord(value) || !isRecord(value.answers) || typeof value.note !== "string") {
    throw new Error(`not the reviewer's typing: ${json}`);
  }

  const answers = Object.entries(value.answers).flatMap(([id, text]) =>
    typeof text === "string" ? [[id, text] as const] : [],
  );

  return { answers: Object.fromEntries(answers), note: value.note };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function replied(doc: string, typing: Typing): string | null {
  const answers = Object.entries(typing.answers).map(([id, text]) => ({ id, text }));

  return appendReply(doc, answers, typing.note);
}

/**
 * What Claude is told of a grill the reviewer opens: its file and its subject, and, at the
 * directory's first grill, where it learns how to grill.
 */
export function openingOf(name: string, subject: string, guide: string | null): string {
  const line = `The reviewer opened ${name} on: ${subject}.`;

  return guide === null ? line : `${line} Read ${guide}, then ask with ${ASK_TOOL}.`;
}

/**
 * An entry of the transcript as Claude reads it: a prompt names its object and repeats nothing
 * Claude wrote or read, and a reply goes as the transcript worded it, under `Reviewer:`.
 */
function toldOf(relay: Relay): string {
  if (relay.kind === "reply") return relay.text;

  return relay.kind === "ended"
    ? `The reviewer ended ${relay.name}.`
    : openingOf(relay.name, relay.subject, null);
}

/** The entries a write added to the transcript, in file order: what the file held before is not told again. */
function told(name: string, before: string, after: string): readonly Effect[] {
  const known = relaysOf(before, name, -1).length - 1;

  return relaysOf(after, name, known).map((relay) => ({
    kind: "channel",
    entry: { kind: "text", from: GRILL, text: toldOf(relay) },
  }));
}

/** The next grill's header, on the subject the reviewer chose; what Claude is told of it rides on the answer's entry. */
function opened(w: Workflow, given: string | undefined, at: string | undefined): Outcome {
  const subject = parseSubject({ subject: given });

  if (subject === null) throw new Error(`a subject the rows passed was refused: ${given ?? ""}`);
  const n = latestIn(w).n + 1;
  const session = /wip-([0-9a-f]{8})\/$/u.exec(w.workspace.dir)?.[1] ?? "";
  const doc = header(subject, session, dateOf(at));

  return {
    workflow: withRegion(w, regionOf({ n, doc })),
    effects: [{ kind: "writeFile", owner: GRILL, file: grillFile(n), text: doc }],
  };
}

function askQuestion(w: Workflow, input: Carried<GrillEvents, "askQuestion">): Outcome {
  const questions = parseQuestions({ q: parseJson(input.q) });

  if (questions === null) throw new Error(`not a round: ${input.q}`);

  return rewritten(w, (doc) => appendQuestions(doc, questions));
}

function turnAnswered(w: Workflow, input: Carried<GrillEvents, "turnAnswered">): Outcome {
  const turn = {
    text: input.text,
    reason: input.reason,
    own: input.own === "true",
    asked: input.asked === "true",
  };

  return rewritten(w, (doc) => appendAnswer(doc, turn));
}

/**
 * End grill: from the page, what the reviewer typed goes as the reply, told before the end; from
 * `/vellum:stop`, the footer alone, told to nobody. A call still waiting reads the grill ended.
 */
function endGrill(w: Workflow, input: Carried<GrillEvents, "endGrill">): Outcome {
  if (!grillIsOpen(w)) return unchanged(w);
  const { n, doc } = latestIn(w);
  const page = input.reason === "page";
  const typing = page ? typingOf(input.grill) : NOTHING_TYPED;
  const after = appendFooter(replied(doc, typing) ?? doc, page ? "page" : "stop", dateOf(input.at));
  const name = grillFile(n);

  return {
    workflow: withRegion(w, regionOf({ n, doc: after })),
    effects: [fileEffect(name, doc, after), ...(page ? told(name, doc, after) : [])],
  };
}

export const TRANSITIONS: Transitions<GrillEvents> = {
  openGrill: (w, input) => opened(w, input.subject, input.at),
  askQuestion,
  turnAnswered,
  sessionEvent: (w, input) => rewritten(w, (doc) => appendEvent(doc, input.command)),
  endGrill,
};

// Its answer to the others' events.

/** The call a `grill_ask` waits under: its transcript, and the first question of the round it asked. */
export function callOf(file: string, first: string): string {
  return `${file}#${first}`;
}

/** The call waiting on the transcript's last round: only the round asked last has one. */
export function roundCall(file: string, doc: string): string {
  const questions = segmentsOf(doc).flatMap((segment) =>
    segment.kind === "question" ? [segment] : [],
  );

  const round = Math.max(0, ...questions.map((question) => question.round));

  return callOf(file, questions.find((question) => question.round === round)?.id ?? "");
}

/** The batch the core's Send just wrote, as the reply's pointer to what else it carried. */
function batchOf(w: Workflow): string {
  const { workspace } = w;

  if (workspace.kind === "approved") throw new Error("an approved plan takes no Send");
  const version = workspace.kind === "drafting" ? null : workspace.version;

  return projectPath(`${workspace.dir}${batchFile(version, workspace.batches)}`);
}

/**
 * The grill's part of the bar's Send (answerQuestion): the reply closes every question open. A
 * call waiting on them takes it as its result, before the transcript takes it, so a write that
 * fails still answers the call; with none waiting, the Send's entry is the prompt.
 */
function answerQuestion(w: Workflow, input: Read<GrillHears, "send">): Outcome {
  if (!grillIsOpen(w) || input.parts !== "true") return unchanged(w);
  const region = regionIn(w, GRILL);
  const { n, doc } = latestIn(w);
  const after = replied(doc, typingOf(input.grill));

  if (after === null) return unchanged(w);
  const name = grillFile(n);
  const reply = relaysOf(after, name, -1).findLast((relay) => relay.kind === "reply");
  const rest = input.comments === "true" ? `\n\nComments and choices: read ${batchOf(w)}.` : "";

  const returned: readonly Effect[] =
    region.state === "open" && region.wait === "open" && reply !== undefined
      ? [{ kind: "returnToCall", call: roundCall(name, doc), text: `${toldOf(reply)}${rest}` }]
      : [];

  return {
    workflow: withRegion(w, regionOf({ n, doc: after })),
    effects: [...returned, fileEffect(name, doc, after)],
  };
}

/**
 * The approval closes the grill open, in the final directory, module alive or not: every question
 * open takes its recommendation by default, then the footer.
 */
function approved(w: Workflow, at: string | undefined): Outcome {
  return rewritten(w, (doc) =>
    appendFooter(replied(doc, NOTHING_TYPED) ?? doc, "approved", dateOf(at)),
  );
}

export const REACTIONS: Reactions<GrillHears> = {
  answerProposal: (w, input) =>
    input.move === "grill" ? opened(w, input.subject, input.at) : unchanged(w),
  send: answerQuestion,
  approve: (w, input) => approved(w, input.at),
};

// The inputs `refusedNow` and the proof of the table (`extensions/proof.ts`) try.

const ROUND = JSON.stringify([["Style", "bright or plain?", "I recommend bright."]]);

export const SAMPLES: Samples<GrillEvents> = {
  openGrill: [
    { subject: "auth", at: SAMPLE_AT },
    { subject: "", at: SAMPLE_AT },
  ],
  askQuestion: [{ q: ROUND }],
  turnAnswered: [
    { text: "Asked.", reason: "answer", own: "false", asked: "true" },
    { text: "", reason: "aborted", own: "false", asked: "true" },
    { text: "Noted.", reason: "answer", own: "true", asked: "false" },
    { text: "partial", reason: "aborted", own: "true", asked: "false" },
  ],
  sessionEvent: [{ command: "/compact" }],
  endGrill: [
    { reason: "page", at: SAMPLE_AT, grill: JSON.stringify({ answers: {}, note: "Enough." }) },
    { reason: "stop", at: SAMPLE_AT, grill: "" },
  ],
};

// How the grill words its region.

export function segmentOf(region: Region): string | null {
  return region.state === "open" ? "grill · open" : null;
}

/** The grill open, what it holds, and whether its question waits on Claude's call, or was cut. */
export function lineOf(region: Region): string {
  if (region.state === "closed") return "grill: closed";
  const holds = region.holds === null ? "" : ` · holds: ${region.holds}`;

  return `grill ${String(region.data.n)}: open${holds} · question: ${region.wait ?? "none"}`;
}
