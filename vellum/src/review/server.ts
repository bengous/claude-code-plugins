import type { Part } from "../runtime/extension.ts";
import type { SendRefusal } from "../runtime/protocol.ts";
import { freeTarget, listReview } from "../runtime/server/fs.ts";
import type { Queue, Stepped } from "../runtime/server/queue.ts";
import type { BatchHeading } from "../workshop/feedback.ts";
import { formatBatch } from "../workshop/feedback.ts";
import type { ProjectPath, Version } from "../workshop/paths.ts";
import type { Decision, Draft, EditKept, SendRequest } from "../workshop/review.ts";
import { EMPTY_DRAFT, namedIn, sendOn, slugFor } from "../workshop/review.ts";
import type { Actor, EventInput, Workflow } from "../workshop/workflow.ts";
import { HELD, held, verdictOf } from "../workshop/workflow.ts";
import type { PlanWorkspace } from "../workshop/workspace.ts";

/**
 * The core's own events as its routes send them: what each reads in the queue before it is
 * judged, and how its answer reads the step. The table decides; the answers that stay the
 * route's are the ones the workflow does not hold: a draft it cannot read, questions no answer
 * takes, and a Send with nothing in it (E10).
 */

/**
 * What a gate does with a `plan.md` whose text is the version under review: `record` opens a new
 * version after a feedback, as the model's explicit call means it; `keep` never does, as the
 * turn's end means nothing new.
 */
export type GateOptions = { readonly unchanged: "record" | "keep" };

/** What `submit`, the turn's end and Record read: the version the plan is, or the row that refused it. */
export type GateResult =
  | { readonly ok: true; readonly version: Version; readonly kept: boolean }
  | { readonly ok: false; readonly rule: string; readonly error: string };

/** An approval taken, refused by a row, or stopped by a rename whose error the workspace carries. */
export type DecisionResult =
  | { readonly ok: true; readonly workspace: PlanWorkspace }
  | {
      readonly ok: false;
      readonly workspace: PlanWorkspace;
      readonly rule: string | null;
      readonly reason: string | null;
    };

/** What a Send did: the batch written, its entry's number and the edit it left, or why nothing was written. */
export type SendResult =
  | {
      readonly ok: true;
      readonly file: ProjectPath;
      readonly seq: number;
      readonly editKept: EditKept | null;
    }
  | { readonly ok: false; readonly refusal: SendRefusal };

export type ReviewServer = {
  readonly gate: (options: GateOptions, actor: Actor) => Promise<GateResult>;
  readonly decide: (decision: Decision) => Promise<DecisionResult>;
  readonly send: (request: SendRequest) => Promise<SendResult>;
};

function refused(refusal: SendRefusal): SendResult {
  return { ok: false, refusal };
}

/** A step the table passed, or the reason its rows gave: an event the route judged first must pass. */
function passed(stepped: Stepped, event: string): Stepped {
  if (stepped.verdict.kind !== "allow") {
    throw new Error(`${event}, judged first, was refused: ${stepped.verdict.reason}`);
  }

  return stepped;
}

export function reviewServer(queue: Queue): ReviewServer {
  const { project, workdir, extensions } = queue.options;

  /** The version `plan.md` would be now: recorded when its text is new, kept when it is not. */
  const gate = (options: GateOptions, actor: Actor): Promise<GateResult> =>
    queue.inOrder(async () => {
      const stepped = await queue.step("record", { unchanged: options.unchanged }, actor);

      if (stepped.verdict.kind !== "allow") {
        return { ok: false, rule: stepped.verdict.rule, error: stepped.verdict.reason };
      }

      const { workspace } = stepped.workflow;

      if (workspace.kind !== "inReview") throw new Error("a version recorded is under review");
      const kept = !stepped.effects.some(({ kind }) => kind === "recordVersion");

      return { ok: true, version: workspace.version, kept };
    });

  /**
   * What an approval reads: the reviewer's edit when it differs from the version under review, the
   * final directory's free name from the approved text's title, and a notes file a first attempt
   * left. The rows judge a stale edit, a draft, a hold.
   */
  const approval = async (w: Workflow, decision: Decision): Promise<EventInput> => {
    const { workspace } = w;
    const asked = { confirmed: decision.confirmed ?? "", notes: decision.notes };

    if (workspace.kind !== "inReview") {
      return { ...asked, edit: "", text: "", dir: "", noted: "false" };
    }

    const latest = await queue.planText(workspace.version, workspace.dir);
    const { edit } = decision;

    if (edit !== null && edit.version !== workspace.version) {
      return { ...asked, edit: String(edit.version), text: edit.text, dir: "", noted: "false" };
    }

    const edited = edit === null || edit.text === latest ? null : edit;
    const slug = slugFor(edited?.text ?? latest);

    if (!slug.ok) throw new Error(slug.error);
    const dir = await freeTarget(project, workdir, slug.value);

    if (!dir.ok) throw new Error(dir.error);
    const version = workspace.version + (edited === null ? 0 : 1);
    const noted = (await listReview(project, workspace.dir)).has(`v${version}.notes.md`);

    return {
      ...asked,
      edit: edited === null ? "" : String(edited.version),
      text: edited?.text ?? "",
      dir: dir.value,
      noted: String(noted),
    };
  };

  const decide = (decision: Decision): Promise<DecisionResult> =>
    queue.inOrder(async () => {
      const stepped = await queue.step("approve", (w) => approval(w, decision), "reviewer");
      const workspace = await queue.workspace();
      const { verdict } = stepped;

      if (verdict.kind !== "allow") {
        return { ok: false, workspace, rule: verdict.rule, reason: verdict.reason };
      }

      return stepped.stopped
        ? { ok: false, workspace, rule: null, reason: null }
        : { ok: true, workspace };
    });

  /** Each extension's part of the bar's Send, never of a Send now; questions no answer takes refuse it. */
  const partsOf = async (
    request: SendRequest,
    draft: Draft,
  ): Promise<
    | { readonly kind: "unanswered"; readonly ids: readonly string[] }
    | {
        readonly kind: "parts";
        readonly parts: readonly {
          readonly id: string;
          readonly part: Extract<Part, { kind: "part" }>;
        }[];
      }
  > => {
    const parts: { readonly id: string; readonly part: Extract<Part, { kind: "part" }> }[] = [];
    const unanswered: string[] = [];

    for (const extension of request.parts ? extensions : []) {
      const part = (await extension.part?.(queue.context, draft, request.takeDefaults)) ?? {
        kind: "none",
      };

      if (part.kind === "unanswered") unanswered.push(...part.ids);
      else if (part.kind === "part") parts.push({ id: extension.id, part });
    }

    return unanswered.length > 0
      ? { kind: "unanswered", ids: unanswered }
      : { kind: "parts", parts };
  };

  /**
   * One Send, one step of the queue: judged whole first (`send`'s rows, F10), a refusal stepped
   * for its journal line alone, and its parts asked; then its edit, when it changes the version's text (`sendEdit`,
   * which a hold refuses: the edit stays in the draft, and the rest goes); then the batch and its
   * entry, the commit point, and each extension's reaction to its part. The draft keeps what the
   * Send did not take; a failure there is logged.
   */
  const send = (request: SendRequest): Promise<SendResult> =>
    queue.inOrder(async () => {
      const w = await queue.workflow();
      const { workspace } = w;
      const stored = await queue.draft();
      const draft = stored === "unreadable" ? EMPTY_DRAFT : (stored ?? EMPTY_DRAFT);
      const edit = request.edit === null ? "" : String(request.edit);
      const names = stored === "unreadable" ? "held" : namedIn(workspace, draft, request);
      const asked = { edit, names };

      if (verdictOf(w, queue.table, "send", asked).kind !== "allow") {
        const { verdict } = await queue.step("send", asked, "reviewer");

        if (verdict.kind === "allow") throw new Error("a Send its rows refused passed its step");

        return refused({ reason: "refused", rule: verdict.rule, text: verdict.reason });
      }

      if (stored === "unreadable") return refused({ reason: "unreadable" });
      const shares = await partsOf(request, draft);

      if (shares.kind === "unanswered") return refused({ reason: "unanswered", ids: shares.ids });

      const latestText =
        workspace.kind === "drafting"
          ? null
          : await queue.planText(workspace.version, workspace.dir);

      const editText = request.edit === null ? null : (draft.edit?.text ?? null);

      const editHeld =
        editText !== null &&
        editText !== latestText &&
        (await queue.step("sendEdit", { edit, text: editText }, "reviewer")).verdict.kind !==
          "allow";

      const sending = sendOn(workspace, latestText, draft, request, editHeld ? held(w) : null);

      if (sending.kind === "refused") {
        throw new Error(`a Send its rows passed was refused: ${sending.reason}`);
      }

      const { annotations, choices, edit: written, version, editedFrom, editKept, rest } = sending;
      const { parts } = shares;

      if (
        annotations.length === 0 &&
        choices.length === 0 &&
        written === null &&
        parts.length === 0
      ) {
        return refused(
          editKept === null
            ? { reason: "empty" }
            : { reason: "refused", rule: HELD, text: editKept.reason },
        );
      }

      const batch = written === null && workspace.kind !== "approved" ? workspace.batches + 1 : 1;

      const heading: BatchHeading =
        version === null
          ? { kind: "draft", batch }
          : { kind: "review", version, batch, editedFrom };

      const text = formatBatch(
        heading,
        parts.map(({ part }) => part.text),
        annotations,
        choices,
      );

      const comments = annotations.length > 0 || choices.length > 0 || written !== null;

      const input: EventInput = {
        parts: String(request.parts),
        edit: "",
        names,
        comments: String(comments),
        text,
        ...Object.fromEntries(parts.map(({ id, part }) => [id, part.input])),
      };

      const stepped = passed(await queue.step("send", input, "reviewer"), "send");
      const sent = stepped.effects.find((effect) => effect.kind === "channel");
      const seq = stepped.appended[0];

      if (sent?.kind !== "channel" || sent.entry.kind !== "sent" || seq === undefined) {
        throw new Error("a Send took no entry");
      }

      const typed = parts.reduce((kept, { part }) => part.typed(kept), rest.typed);

      await queue.keepDraft({ ...rest, typed }).catch((cause: unknown) => {
        console.error(`a Send was committed, then the draft's rest failed: ${String(cause)}`);
      });

      return { ok: true, file: sent.entry.file, seq, editKept };
    });

  return { gate, decide, send };
}
