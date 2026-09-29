import type { Queue } from "../runtime/server/queue.ts";
import { DRAFT_FILE } from "../workshop/workspace.ts";
import type { DecisionAnswer, GateAnswer, RecordAnswer, SendAnswer } from "./contract.ts";
import { parseDraft } from "./draft.ts";
import { parseDecision, parseGateOptions, parseSend } from "./parse.ts";
import type { ReviewServer } from "./server.ts";

/**
 * The review's own routes, which `runtime/server/http/routes.ts` hands each request before its
 * own: the gate and Record, the approval, the Send, the draft. Each answers its status and its
 * JSON, a refusal by a row the status that row declares; `undefined` is a route of somebody else's.
 */

export type ReviewRoutes = {
  readonly queue: Queue;
  readonly review: ReviewServer;
  /** Opens the browser when no tab listens: a gate shows its version. */
  readonly open: () => void;
};

/** A saved draft the parser refuses was written by an older page: nothing of it is read half-way. */
export const UNREADABLE_DRAFT = `${DRAFT_FILE} was saved by an older version of vellum and cannot be read: delete it, then reload.`;

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

export async function reviewRoute(
  context: ReviewRoutes,
  request: Request,
  route: string,
): Promise<Response | undefined> {
  const { queue, review } = context;

  if (route === "POST /api/gate") {
    const gated = await review.gate(await parseGateOptions(request), "claude");

    if (!gated.ok) {
      const refused: GateAnswer = { error: gated.error };

      return Response.json(refused, { status: gated.status });
    }

    context.open();
    const answer: GateAnswer = { version: gated.version, kept: gated.kept };

    return Response.json(answer);
  }

  if (route === "POST /api/record") {
    const recorded = await review.gate({ unchanged: "record" }, "reviewer");

    const answer: RecordAnswer = recorded.ok
      ? { version: recorded.version }
      : { rule: recorded.rule, reason: recorded.error };

    return Response.json(answer, { status: recorded.ok ? 200 : recorded.status });
  }

  if (route === "POST /api/decision") {
    const decision = await parseDecision(request);

    if (decision === null) return badRequest();
    const result = await review.decide(decision);
    const { workspace } = result;

    const answer: DecisionAnswer =
      result.ok || result.rule === null || result.reason === null
        ? { workspace }
        : { workspace, rule: result.rule, reason: result.reason };

    return Response.json(answer, { status: result.ok ? 200 : result.status });
  }

  if (route === "POST /api/send") {
    const sending = await parseSend(request);

    if (sending === null) return badRequest();
    const sent = await review.send(sending);

    const answer: SendAnswer = sent.ok
      ? { file: sent.file, seq: sent.seq, editKept: sent.editKept }
      : sent.refusal;

    return Response.json(answer, { status: sent.ok ? 200 : sent.status });
  }

  if (route === "GET /api/draft") {
    const draft = await queue.draft();

    if (draft === null) return new Response(null, { status: 204 });

    return draft === "unreadable"
      ? Response.json({ error: UNREADABLE_DRAFT }, { status: 409 })
      : Response.json(draft);
  }

  if (route === "PUT /api/draft") {
    const draft = parseDraft(await request.json().catch(() => null));

    if (draft === null) return badRequest();

    return new Response(null, { status: (await queue.saveDraft(draft)) ? 204 : 409 });
  }

  return undefined;
}
