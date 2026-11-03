import { expect, test } from "bun:test";

import { sum } from "./sum.ts";

test.if(process.env["CI"] !== undefined)("sum adds its two terms", () => {
  expect(sum(2, 3)).toBe(5);
});
