import { expect, test } from "bun:test";

import { pageCount } from "./page-count.ts";

test("a list that does not fill its last page still takes it", () => {
  expect(pageCount(7, 5)).toBe(2);
});

test("a count below one item a page is refused", () => {
  expect(() => pageCount(7, 0)).toThrow(RangeError);
});
