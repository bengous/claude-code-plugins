/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- expectations are branded ProjectPath literals; the brand is the parser's to grant. */
import { describe, expect, test } from "bun:test";

import { linkedDocs } from "./server.ts";

const ROOTS = { project: "/repo", planDir: "plans/2026-09-15/wip-4c2a9d93" };

describe("linkedDocs", () => {
  test("finds link targets, image sources, backticked paths and absolute paths under the project", () => {
    const plan = [
      "[a](plans/2026-09-15/wip-4c2a9d93/a.html)",
      '<img src="shot.png">',
      "Mockup: `plans/2026-09-15/wip-4c2a9d93/b.html`",
      "See `/repo/plans/2026-09-15/wip-4c2a9d93/c.md` and `/elsewhere/d.md`",
      "[web](https://example.com/x.html) [code](src/main.ts) [bad](results-100%.md)",
    ].join("\n");

    expect(linkedDocs(plan, ROOTS).map((doc) => doc.path)).toEqual([
      "plans/2026-09-15/wip-4c2a9d93/a.html",
      "plans/2026-09-15/wip-4c2a9d93/plans/2026-09-15/wip-4c2a9d93/a.html",
      "shot.png",
      "plans/2026-09-15/wip-4c2a9d93/shot.png",
      "plans/2026-09-15/wip-4c2a9d93/b.html",
      "plans/2026-09-15/wip-4c2a9d93/plans/2026-09-15/wip-4c2a9d93/b.html",
      "plans/2026-09-15/wip-4c2a9d93/c.md",
      "results-100%.md",
      "plans/2026-09-15/wip-4c2a9d93/results-100%.md",
    ] as never);
  });

  test("a malformed percent sequence never throws; the server drops what does not exist", () => {
    expect(() => linkedDocs("[x](results-100%.md)", ROOTS)).not.toThrow();
  });
});
