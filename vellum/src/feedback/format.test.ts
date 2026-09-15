/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { expect, test } from "bun:test";

import type { Annotation } from "../protocol.ts";
import { formatFeedback } from "./format.ts";

const DOC = "plans/2026-09-15/wip-4c2a9d93/.review/v2.md" as never;

test("formatFeedback numbers the comments, quotes text anchors, names general ones", () => {
  const annotations: Annotation[] = [
    {
      id: "a",
      doc: DOC,
      anchor: { kind: "text", quote: "persist per user", prefix: "", suffix: "", lines: [14, 14] },
      body: "A JSON column is enough.\nOne boolean.",
    },
    { id: "b", doc: DOC, anchor: { kind: "global" }, body: "Slice 2 needs an empty state." },
  ];

  expect(formatFeedback(annotations, 2 as never)).toBe(
    [
      "# Plan review: changes requested (v2)",
      "",
      `1. \`${DOC}\` lines 14–14: "persist per user"`,
      "   A JSON column is enough.",
      "   One boolean.",
      "",
      `2. \`${DOC}\`, general`,
      "   Slice 2 needs an empty state.",
      "",
    ].join("\n"),
  );
});
