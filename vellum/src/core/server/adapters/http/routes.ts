import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";

import type { Route } from "../../../extension.ts";
import type {
  Anchor,
  Annotation,
  Decision,
  Draft,
  Edit,
  ElementDescription,
  ElementRef,
  GateAnswer,
  Mark,
  Passage,
  PassageKind,
  PlanWorkspace,
  Typed,
  VellumBuild,
  WordsContext,
} from "../../../protocol.ts";
import type { GateOptions, Review } from "../../app/review.ts";
import { isQuickLabel } from "../../domain/feedback.ts";
import { parseProjectPath, parseVersion } from "../../domain/paths.ts";
import type { ParseResult } from "../../domain/paths.ts";
import { DRAFT_FILE } from "../../domain/workspace.ts";

export const TOKEN_HEADER = "x-vellum-token";

export type RouteContext = {
  readonly token: string;
  readonly project: string;
  readonly review: Review;
  /** `extensions/html/frame.ts`, built; every HTML file served carries a tag that loads it. */
  readonly frameScript: string;
  /** The extensions' own routes, keyed as `api` keys its own: `POST /api/x/<id>/<name>`. */
  readonly extensionRoutes: ReadonlyMap<string, Route>;
  readonly openBrowser: () => void;
  readonly heartbeat: () => void;
  /** Read once at start; a failure is this route's answer, never the server's. */
  readonly vellumBuild: ParseResult<VellumBuild>;
};

/**
 * `openStreams` counts the tabs that listen. The review's own listeners cannot say: `serve.ts`
 * keeps one there for itself, so that set is never empty.
 */
export type Handler = {
  readonly handle: (request: Request) => Promise<Response>;
  readonly openStreams: () => number;
};

type Streams = { open: number };

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- the block below IS the boundary parser the rules ask for: it validates the JSON bodies the browser and the hooks module post, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseAnchor(value: unknown): Anchor | null {
  if (!isRecord(value)) return null;

  if (value.kind === "global") return { kind: "global" };

  if (value.kind === "element") {
    if (!Array.isArray(value.elements)) return null;
    const elements = value.elements.map(parseElementRef);

    if (elements.some((element) => element === null)) return null;
    const [head, ...tail] = elements.filter((element) => element !== null);

    return head === undefined ? null : { kind: "element", elements: [head, ...tail] };
  }

  if (value.kind !== "text" || !Array.isArray(value.passages)) return null;
  const parsed = value.passages.map(parsePassage);

  if (parsed.some((passage) => passage === null)) return null;
  const [first, ...rest] = parsed.filter((passage) => passage !== null);

  return first === undefined ? null : { kind: "text", passages: [first, ...rest] };
}

function parseWordsContext(value: unknown): WordsContext | null {
  if (
    !isRecord(value) ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    typeof value.repeated !== "boolean"
  ) {
    return null;
  }

  return { prefix: value.prefix, suffix: value.suffix, repeated: value.repeated };
}

function parseElementDescription(value: unknown): ElementDescription | null {
  if (
    !isRecord(value) ||
    typeof value.heading !== "string" ||
    typeof value.role !== "string" ||
    typeof value.name !== "string" ||
    typeof value.openingTag !== "string"
  ) {
    return null;
  }

  const { heading, role, name, openingTag } = value;

  return { heading, role, name, openingTag };
}

/**
 * A page older than the description sends none, and a draft it saved holds none: that draft keeps
 * the reviewer's unsent comments, so the element is read with no description rather than refused.
 */
function parseOptionalDescription(value: unknown): ElementDescription | null | "unreadable" {
  if (value === undefined || value === null) return null;

  return parseElementDescription(value) ?? "unreadable";
}

function parseElementRef(value: unknown): ElementRef | null {
  const context = isRecord(value) ? parseWordsContext(value.context) : null;
  const description = isRecord(value) ? parseOptionalDescription(value.description) : "unreadable";

  if (
    !isRecord(value) ||
    context === null ||
    description === "unreadable" ||
    typeof value.selector !== "string" ||
    value.selector === "" ||
    typeof value.text !== "string" ||
    typeof value.label !== "string"
  ) {
    return null;
  }

  return { selector: value.selector, text: value.text, label: value.label, context, description };
}

function parsePassageKind(value: unknown): PassageKind | null {
  return value === "prose" || value === "code" || value === "diagram" ? value : null;
}

function parsePassage(value: unknown): Passage | null {
  const kind = isRecord(value) ? parsePassageKind(value.kind) : null;

  if (
    !isRecord(value) ||
    kind === null ||
    typeof value.quote !== "string" ||
    typeof value.prefix !== "string" ||
    typeof value.suffix !== "string" ||
    !Array.isArray(value.lines) ||
    typeof value.lines[0] !== "number" ||
    typeof value.lines[1] !== "number" ||
    typeof value.removed !== "boolean"
  ) {
    return null;
  }

  return {
    kind,
    quote: value.quote,
    prefix: value.prefix,
    suffix: value.suffix,
    lines: [value.lines[0], value.lines[1]],
    removed: value.removed,
  };
}

function parseMark(value: unknown): Mark | null {
  if (!isRecord(value)) return null;

  if (value.kind === "delete") return { kind: "delete" };

  if (value.kind === "label") {
    return typeof value.label === "string" && isQuickLabel(value.label)
      ? { kind: "label", label: value.label }
      : null;
  }

  return value.kind === "comment" && typeof value.body === "string"
    ? { kind: "comment", body: value.body }
    : null;
}

function parseAnnotation(value: unknown): Annotation | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const doc = typeof value.doc === "string" ? parseProjectPath(value.doc) : null;
  const anchor = parseAnchor(value.anchor);
  const mark = parseMark(value.mark);

  if (doc?.ok !== true || anchor === null || mark === null) return null;

  // "Delete this" needs a place to delete: the document as a whole is not one.
  return mark.kind === "delete" && anchor.kind === "global"
    ? null
    : { id: value.id, doc: doc.value, anchor, mark };
}

function parseAnnotations(value: unknown): readonly Annotation[] | null {
  if (!Array.isArray(value)) return null;
  const annotations = value.map((annotation: unknown) => parseAnnotation(annotation));

  return annotations.every((annotation) => annotation !== null) ? annotations : null;
}

/** `null` is a decision without an edit, so a refusal is no `null`: the parsed edit comes wrapped. */
function parseEdit(value: unknown): { readonly value: Edit | null } | null {
  if (value === null) return { value: null };

  if (!isRecord(value) || typeof value.version !== "number" || typeof value.text !== "string") {
    return null;
  }

  const version = parseVersion(value.version);

  return version.ok ? { value: { version: version.value, text: value.text } } : null;
}

async function parseDecision(request: Request): Promise<Decision | null> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) return null;

  const edit = parseEdit(body.edit);

  if (edit === null) return null;

  if (body.kind === "approve") {
    return typeof body.notes === "string"
      ? { kind: "approve", edit: edit.value, notes: body.notes }
      : null;
  }

  const annotations = body.kind === "feedback" ? parseAnnotations(body.annotations) : null;

  return annotations === null ? null : { kind: "feedback", edit: edit.value, annotations };
}

function parseStrings(value: unknown): Readonly<Record<string, string>> | null {
  if (!isRecord(value)) return null;
  const strings: Record<string, string> = {};

  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") return null;
    strings[key] = text;
  }

  return strings;
}

function parseGrillTyped(value: unknown): Typed["grill"] | null {
  if (!isRecord(value)) return null;
  const grill: Record<string, { answers: Readonly<Record<string, string>>; note: string }> = {};

  for (const [path, entry] of Object.entries(value)) {
    const answers = isRecord(entry) ? parseStrings(entry.answers) : null;

    if (answers === null || !isRecord(entry) || typeof entry.note !== "string") return null;
    grill[path] = { answers, note: entry.note };
  }

  return grill;
}

function parseTyped(value: unknown): Typed | null {
  if (!isRecord(value) || typeof value.general !== "string") return null;
  const composer = parseStrings(value.composer);
  const grill = parseGrillTyped(value.grill);
  const editor = parseEdit(value.editor);

  return composer === null || grill === null || editor === null
    ? null
    : { general: value.general, composer, grill, editor: editor.value };
}

/**
 * The same annotations and the same edit a decision carries, so a restored draft can be sent as
 * it is, plus what is typed. A draft of an older shape is refused whole, written or read back.
 */
function parseDraft(body: unknown): Draft | null {
  if (!isRecord(body)) return null;
  const annotations = parseAnnotations(body.annotations);
  const edit = parseEdit(body.edit);
  const typed = parseTyped(body.typed);

  return annotations === null || edit === null || typed === null
    ? null
    : { annotations, edit: edit.value, typed };
}

/** The saved file, read back through the same parser a PUT goes through. */
function readDraft(saved: string): Draft | null {
  try {
    return parseDraft(JSON.parse(saved));
  } catch {
    return null;
  }
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

function badRequest(): Response {
  return new Response("bad request", { status: 400 });
}

/** A saved draft the parser refuses was written by an older page: nothing of it is read half-way. */
export const UNREADABLE_DRAFT = `${DRAFT_FILE} was saved by an older version of vellum and cannot be read: delete it, then reload.`;

async function parseGateOptions(request: Request): Promise<GateOptions> {
  const body: unknown = await request.json().catch(() => null);

  return isRecord(body) && body.unchanged === "keep"
    ? { unchanged: "keep" }
    : { unchanged: "record" };
}

/** The tag goes before the last `</body>`, or at the end of a document without one. */
function withFrameScript(html: string, tag: string): string {
  const at = html.lastIndexOf("</body>");

  return at === -1 ? `${html}${tag}` : `${html.slice(0, at)}${tag}${html.slice(at)}`;
}

async function serveFile(project: string, rawPath: string, tag: string): Promise<Response> {
  let decoded: string;

  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return new Response("forbidden", { status: 403 });
  }

  const parsed = parseProjectPath(decoded);

  if (!parsed.ok) return new Response("forbidden", { status: 403 });
  const root = await realpath(project);
  const resolved = await realpath(join(root, parsed.value)).catch(() => null);

  if (resolved === null) return new Response("not found", { status: 404 });

  if (!resolved.startsWith(root + sep)) return new Response("forbidden", { status: 403 });
  const file = Bun.file(resolved);

  if (!(await file.exists())) return new Response("not found", { status: 404 });

  const headers = {
    "content-type": file.type,
    "content-security-policy": "sandbox allow-scripts",
    "cache-control": "no-store",
  };

  if (!file.type.startsWith("text/html")) return new Response(file, { headers });

  return new Response(withFrameScript(await file.text(), tag), { headers });
}

function sse(review: Review, streams: Streams): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (workspace: PlanWorkspace): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "workspace", workspace })}\n\n`),
        );
      };

      streams.open += 1;
      unsubscribe = review.subscribe(send);
      send(await review.workspace());
    },
    cancel() {
      streams.open -= 1;
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}

async function api(
  context: RouteContext,
  streams: Streams,
  request: Request,
  route: string,
): Promise<Response> {
  const { review } = context;

  if (route === "GET /api/review") return Response.json(await review.view());

  if (route === "GET /api/pending") return Response.json(await review.poll());

  if (route === "GET /api/vellum-build") {
    const build = context.vellumBuild;

    return build.ok
      ? Response.json(build.value)
      : Response.json({ error: build.error }, { status: 500 });
  }

  if (route === "POST /api/heartbeat") {
    context.heartbeat();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/open") {
    if (streams.open === 0) context.openBrowser();

    return new Response(null, { status: 204 });
  }

  if (route === "POST /api/gate") {
    const gated = await review.gate(await parseGateOptions(request));

    if (!gated.ok) {
      const refused: GateAnswer = { error: gated.error };

      return Response.json(refused, { status: 409 });
    }

    if (streams.open === 0) context.openBrowser();
    const answer: GateAnswer = { version: gated.version, kept: gated.kept };

    return Response.json(answer);
  }

  if (route === "POST /api/decision") {
    const decision = await parseDecision(request);

    if (decision === null) return badRequest();
    const result = await review.decide(decision);

    return Response.json({ workspace: result.workspace }, { status: result.ok ? 200 : 409 });
  }

  if (route === "GET /api/draft") {
    const saved = await review.draft();

    if (saved === null) return new Response(null, { status: 204 });
    const draft = readDraft(saved);

    return draft === null
      ? Response.json({ error: UNREADABLE_DRAFT }, { status: 409 })
      : Response.json(draft);
  }

  if (route === "PUT /api/draft") {
    const draft = parseDraft(await request.json().catch(() => null));

    if (draft === null) return badRequest();

    return new Response(null, { status: (await review.saveDraft(draft)) ? 204 : 409 });
  }

  const extensionRoute = context.extensionRoutes.get(route);

  return extensionRoute === undefined
    ? new Response("not found", { status: 404 })
    : await extensionRoute(request);
}

/** Everything but the page itself, which `Bun.serve` routes to the bundled HTML. */
export function createHandler(context: RouteContext): Handler {
  const filesPrefix = `/t/${context.token}/files/`;
  const eventsPath = `/t/${context.token}/events`;
  const framePath = `/t/${context.token}/frame.js`;
  const frameTag = `<script src="${framePath}"></script>`;
  const streams: Streams = { open: 0 };

  const handle: Handler["handle"] = async (request) => {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname.startsWith("/api/")) {
      if (request.headers.get(TOKEN_HEADER) !== context.token) {
        return new Response("unauthorized", { status: 401 });
      }

      return await api(context, streams, request, `${request.method} ${pathname}`);
    }

    if (request.method === "GET" && pathname === framePath) {
      return new Response(context.frameScript, {
        headers: { "content-type": "text/javascript", "cache-control": "no-store" },
      });
    }

    if (request.method === "GET" && pathname.startsWith(filesPrefix)) {
      return await serveFile(context.project, pathname.slice(filesPrefix.length), frameTag);
    }

    if (request.method === "GET" && pathname === eventsPath) return sse(context.review, streams);

    return new Response("not found", { status: 404 });
  };

  return { handle, openStreams: () => streams.open };
}
