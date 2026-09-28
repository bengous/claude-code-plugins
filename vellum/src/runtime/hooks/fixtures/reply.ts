import type { HttpResponse } from "claude-code";

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- `value` is the body a route answers, the JSON the module parses at its own boundary; a named type here would be the module's private shape.
export function reply(status: number, value: unknown): HttpResponse {
  return { status, ok: status < 300, headers: {}, text: JSON.stringify(value) };
}
