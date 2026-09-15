import { expect, test } from "bun:test";

import { rewriteLinks } from "./links.ts";
import { parseFinalDir, parseWipDir } from "./paths.ts";

test("rewriteLinks replaces the exact wip path everywhere and nothing else", () => {
  const from = parseWipDir("plans/2026-09-15/wip-4c2a9d93/");
  const to = parseFinalDir("plans/2026-09-15/notification/");

  if (!from.ok || !to.ok) throw new Error("fixture");

  const text =
    "[a](plans/2026-09-15/wip-4c2a9d93/a.html) and plans/2026-09-15/wip-4c2a9d93/b.png, not wip-4c2a9d93";

  expect(rewriteLinks(text, from.value, to.value)).toBe(
    "[a](plans/2026-09-15/notification/a.html) and plans/2026-09-15/notification/b.png, not wip-4c2a9d93",
  );
});
