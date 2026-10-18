import { describe, expect, test } from "bun:test";

import { targetOf } from "./target.ts";

describe("an app's address", () => {
  test.each([
    ["http://localhost:5173/", "http://localhost:5173/"],
    ["https://app.test/admin?tab=1", "https://app.test/admin?tab=1"],
    ["  localhost:3000/admin ", "http://localhost:3000/admin"],
    ["5173", "http://localhost:5173/"],
  ])("%p is %p", (typed, href) => {
    expect(targetOf(typed)?.href).toBe(href);
  });

  test.each(["", "ftp://files.example/", "javascript:alert(1)", "not an address", "http://"])(
    "%p is none",
    (typed) => {
      expect(targetOf(typed)).toBeNull();
    },
  );
});
