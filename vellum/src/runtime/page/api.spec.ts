/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures are branded ProjectPath literals; the brand is the parser's to grant, and nothing here parses. */
import { afterEach, describe, expect, test } from "bun:test";

import { docUrl, fileUrl } from "./api.ts";

/** Bun has no `location`: the page's URL is a fake for one test, then gone. */
function openedAt(pathname: string): void {
  Object.defineProperty(globalThis, "location", { value: { pathname }, configurable: true });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

describe("the token", () => {
  test("a file's URL carries the token of the URL the page was opened at", () => {
    openedAt("/t/4c2a9d93/");

    expect(fileUrl("vellum/AGENTS.md" as never)).toBe("/t/4c2a9d93/files/vellum/AGENTS.md");
  });

  test("a document's URL changes with its mtime, so a rewrite loads again", () => {
    openedAt("/t/4c2a9d93/");
    const doc = { path: "plans/mockup.html", mediaType: "text/html", modified: 1758400000000 };

    expect(docUrl(doc as never)).toBe("/t/4c2a9d93/files/plans/mockup.html?v=1758400000000");
  });

  test("a URL with no token yields an empty one", () => {
    openedAt("/");

    expect(fileUrl("a.md" as never)).toBe("/t//files/a.md");
  });
});
