import { sourceText } from "../model/sources.ts";
import type { SourceText } from "../model/sources.ts";
import type { SourceLines } from "./wire.ts";

// GET /source?path=<path>&from=<line>&to=<line>, the lines the page shows when a citation's marker
// is clicked: the one route that reads a file of the user's. It answers only, in this order:
//   - a map whose Config names a sources root (404);
//   - a path a <cite> or a `src` of the map names, as written (403), so a request reads nothing
//     the map does not point at;
//   - lines from 1, `from` no later than `to` (400);
//   - a file under the root: no absolute path, no `..`, no link out of it (403), a file that is
//     there (404; sourceFile);
//   - a text file of at most SOURCE_CAP_BYTES (413), with no NUL byte, in UTF-8 (415);
//   - a `from` within the file (416), the answer cut at its last line.
// serve.ts asks the Host check first, as of every route. A page of another origin may send the
// request, as any GET, but cannot read the answer: the server sends no CORS header.

/** The map's sources root, resolved, and every path a citation or a `src` of the map names. */
export type Sources = { readonly root: string; readonly paths: ReadonlySet<string> };

const LINE = /^[1-9]\d{0,8}$/u;

const STATUS: Readonly<Record<Extract<SourceText, { kind: "refused" }>["why"], number>> = {
  root: 404,
  outside: 403,
  missing: 404,
  large: 413,
  binary: 415,
};

const refused = (status: number, why: string): Response =>
  new Response(why, { status, headers: { "cache-control": "no-store" } });

export function sourceAnswer(sources: Sources | null, query: URLSearchParams): Response {
  if (sources === null) {
    return refused(404, "this map names no sources: its Config sets no sources root");
  }

  const path = query.get("path") ?? "";

  if (!sources.paths.has(path)) {
    return refused(403, `no citation or src of this map names ${path}`);
  }

  const [from, to] = [query.get("from") ?? "", query.get("to") ?? ""];

  if (!LINE.test(from) || !LINE.test(to) || Number(from) > Number(to)) {
    return refused(
      400,
      "from and to are line numbers from 1, of at most 9 digits, from no later than to",
    );
  }

  const text = sourceText(sources.root, path);

  if (text.kind === "refused") {
    return refused(STATUS[text.why], text.reason);
  }

  const first = Number(from);

  if (first > text.lines.length) {
    return refused(416, `${path} has ${text.lines.length} lines: line ${first} is past its end`);
  }

  const answer: SourceLines = { path, from: first, lines: text.lines.slice(first - 1, Number(to)) };

  return Response.json(answer, { headers: { "cache-control": "no-store" } });
}
