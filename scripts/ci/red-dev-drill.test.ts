import { expect, test } from "bun:test";

test("runs outside CI", () => {
  expect(process.env.CI).toBeUndefined();
});
