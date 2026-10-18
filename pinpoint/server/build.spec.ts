import { expect, test } from "bun:test";

import { buildOverlay } from "./build.ts";

test("the overlays of two sessions differ by the session's directory alone", async () => {
  const shop = "/work/u/shop";
  const blog = "/work/u/blog";
  const [forShop, forBlog] = await Promise.all([buildOverlay(shop), buildOverlay(blog)]);

  expect(forShop).not.toBe(forBlog);
  expect(forShop.replaceAll(JSON.stringify(shop), JSON.stringify(blog))).toBe(forBlog);
});
