import { expect, test } from "bun:test";
import { join } from "node:path";

import { labelsOf, loadFolder } from "./folder.ts";
import { treeOf } from "./tree.ts";

test("labelsOf names each node by its label, by id", async () => {
  const { map } = await loadFolder(join(import.meta.dir, "..", "..", "fixtures", "sample"));
  const labels = labelsOf(treeOf(map));

  expect(labels).toMatchObject({ data: "Storage", backup: "Nightly backup", db: "Database" });
  expect(Object.keys(labels)).toHaveLength(12);
});
