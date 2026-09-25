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

  test.if(process.platform === "win32")(
    "on Windows, a drive path under the project and a relative path in backslashes are linked",
    () => {
      const roots = { project: "C:\\repo", planDir: "plans/2026-09-15/wip-4c2a9d93" };
      const plan = "See `C:\\repo\\docs\\a.md`, `C:/repo/docs/b.md` and `docs\\c.md`";

      expect(linkedDocs(plan, roots).map((doc) => doc.path)).toEqual([
        "docs/a.md",
        "docs/b.md",
        "docs/c.md",
        "plans/2026-09-15/wip-4c2a9d93/docs/c.md",
      ] as never);
    },
  );

  test.if(process.platform === "win32")(
    "on Windows, a path on another drive is outside the project: `relative` answers it whole",
    () => {
      const roots = { project: "C:\\repo", planDir: "plans/2026-09-15/wip-4c2a9d93" };

      expect(linkedDocs("See `D:\\other\\x.md` and `D:/other/y.md`", roots)).toEqual([]);
    },
  );

  test.if(process.platform !== "win32")(
    "elsewhere, a drive spelling is a URL scheme, as it always was: `c:/x.md` is no link",
    () => {
      expect(linkedDocs("See [x](c:/x.md)", ROOTS)).toEqual([]);
    },
  );

  test("a malformed percent sequence never throws; the server drops what does not exist", () => {
    expect(() => linkedDocs("[x](results-100%.md)", ROOTS)).not.toThrow();
  });
});
