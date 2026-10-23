import { expect, test } from "bun:test";

import { openerOf } from "./open.ts";

test("the opener is the platform's own, and none where the plugin has none", () => {
  expect(openerOf("linux")).toBe("xdg-open");
  expect(openerOf("darwin")).toBe("open");
  expect(openerOf("win32")).toBeNull();
});
