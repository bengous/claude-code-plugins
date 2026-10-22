import { expect, test } from "bun:test";
import { join } from "node:path";

import { labelsOf, planOf } from "./folder.ts";

test("labelsOf names each zone by its title and each brick by its label, by id", async () => {
  const labels = labelsOf(await planOf(join(import.meta.dir, "fixtures", "sample")));

  expect(labels).toMatchObject({ data: "Storage", backup: "Nightly backup", db: "Database" });
  expect(Object.keys(labels)).toHaveLength(12);
});
