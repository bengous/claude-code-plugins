import { parseProjectPath, parseVersion } from "../workshop/paths.ts";
import { isRecord, parseEdit } from "./draft.ts";
import type { ChoiceRef } from "./feedback.ts";
import type { Decision, SendRequest } from "./review.ts";
import type { GateOptions } from "./server.ts";

/**
 * The boundary of the review's routes: the bodies the browser and the hooks module post to the
 * gate, the approval and the Send. The draft's own parser is `draft.ts`.
 */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the browser and the hooks module post, and there is no earlier place to parse them. */
export async function parseDecision(request: Request): Promise<Decision | null> {
  const body: unknown = await request.json().catch(() => null);
  const edit = isRecord(body) ? parseEdit(body.edit) : null;

  if (
    !isRecord(body) ||
    edit === null ||
    body.kind !== "approve" ||
    typeof body.notes !== "string" ||
    (body.confirmed !== undefined && typeof body.confirmed !== "string")
  ) {
    return null;
  }

  const decision: Decision = { kind: "approve", edit: edit.value, notes: body.notes };

  return typeof body.confirmed === "string" ? { ...decision, confirmed: body.confirmed } : decision;
}

function parseIds(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((id: unknown) => typeof id === "string")
    ? value.map(String)
    : null;
}

function parseChoiceRef(value: unknown): ChoiceRef | null {
  const doc = isRecord(value) && typeof value.doc === "string" ? parseProjectPath(value.doc) : null;

  return isRecord(value) &&
    doc?.ok === true &&
    typeof value.decision === "string" &&
    value.decision !== "" &&
    typeof value.option === "string" &&
    value.option !== ""
    ? { doc: doc.value, decision: value.decision, option: value.option }
    : null;
}

function parseChoiceRefs(value: unknown): readonly ChoiceRef[] | null {
  if (!Array.isArray(value)) return null;
  const refs = value.map((ref: unknown) => parseChoiceRef(ref));

  return refs.every((ref) => ref !== null) ? refs : null;
}

/** What a Send takes, named as the page saw it: comment ids, the edit's version or `null`, the choices, whether the parts go, the defaults agreed. */
export async function parseSend(request: Request): Promise<SendRequest | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.parts !== "boolean") return null;
  const annotations = parseIds(body.annotations);
  const choices = parseChoiceRefs(body.choices);
  const takeDefaults = parseIds(body.takeDefaults);
  const edit = typeof body.edit === "number" ? parseVersion(body.edit) : null;

  if (
    annotations === null ||
    choices === null ||
    takeDefaults === null ||
    (body.edit !== null && edit?.ok !== true)
  ) {
    return null;
  }

  return {
    annotations,
    edit: edit?.ok === true ? edit.value : null,
    choices,
    parts: body.parts,
    takeDefaults,
  };
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

export async function parseGateOptions(request: Request): Promise<GateOptions> {
  const body: unknown = await request.json().catch(() => null);

  return isRecord(body) && body.unchanged === "keep"
    ? { unchanged: "keep" }
    : { unchanged: "record" };
}
