import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { FOLDER_LINE, folderLineOf, labelsOf, loadFolder, readFolderLine } from "./folder.ts";
import { treeOf } from "./tree.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures");

const SAMPLE = join(FIXTURES, "sample");

const CITATIONS = join(FIXTURES, "citations");

test("labelsOf names each node by its label, by id", async () => {
  const { map } = await loadFolder(SAMPLE);
  const labels = labelsOf(treeOf(map));

  expect(labels).toMatchObject({ data: "Storage", backup: "Nightly backup", db: "Database" });
  expect(Object.keys(labels)).toHaveLength(12);
});

describe("folderLineOf", () => {
  test("carries the sources root, resolved from the map folder, and every path a citation or a src names", async () => {
    const { map, config } = await loadFolder(CITATIONS);

    expect(folderLineOf(map, config, CITATIONS).sources).toEqual({
      root: join(CITATIONS, "repo"),
      paths: [
        "cmd/shop/main.go",
        "db/schema.sql",
        "orders/mail.go",
        "orders/orders.go",
        "web/routes.go",
      ],
    });
  });

  test("names a path a src alone names, and none of a kicker", async () => {
    const { map, config } = await loadFolder(CITATIONS);
    const root = { ...map.root, src: "README.md", kicker: "LICENSE:1" };

    expect(folderLineOf({ ...map, root }, config, CITATIONS).sources?.paths).toContain("README.md");
    expect(folderLineOf({ ...map, root }, config, CITATIONS).sources?.paths).not.toContain(
      "LICENSE",
    );
  });

  test("carries no sources for a map whose Config names none", async () => {
    const { map, config } = await loadFolder(SAMPLE);

    expect(folderLineOf(map, config, SAMPLE)).toEqual({
      labels: labelsOf(treeOf(map)),
      sources: null,
    });
  });
});

describe("the folder module's line", () => {
  test("run on a map folder, is the line folderLineOf makes, which readFolderLine reads back", async () => {
    const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "folder.ts"), CITATIONS]);
    const { map, config } = await loadFolder(CITATIONS);

    expect(run.exitCode).toBe(0);
    expect(readFolderLine(run.stdout.toString())).toEqual(folderLineOf(map, config, CITATIONS));
  });

  test("is read from the last marked line, whatever the map's code printed before it", () => {
    const line = { labels: { a: "A" }, sources: { root: "/repo", paths: ["a.go"] } };
    const stdout = `${FOLDER_LINE}{"labels":{},"sources":null}\nthe map's own line\n${FOLDER_LINE}${JSON.stringify(line)}\n`;

    expect(readFolderLine(stdout)).toEqual(line);
  });

  test.each([
    ["no marked line", "atlas labels: {}"],
    ["no JSON", `${FOLDER_LINE}{`],
    ["labels that are not text", `${FOLDER_LINE}{"labels":{"a":1},"sources":null}`],
    ["no sources", `${FOLDER_LINE}{"labels":{}}`],
    ["a root that is not text", `${FOLDER_LINE}{"labels":{},"sources":{"root":1,"paths":[]}}`],
    ["paths that are not text", `${FOLDER_LINE}{"labels":{},"sources":{"root":"/r","paths":[1]}}`],
  ])("reads as no map when it holds %s", (_, stdout) => {
    expect(readFolderLine(stdout)).toBeNull();
  });
});
