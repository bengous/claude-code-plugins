import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import sample from "./fixtures/sample/map.ts";
import { QueryError, queryNode } from "./query.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

describe("queryNode", () => {
  test("a leaf: its path from the root, its links both ways with their labels, its fields and sources", () => {
    const answer = queryNode(sample, "orders");

    expect(answer.map).toBe("Bookshop");
    expect(answer.path).toEqual([
      { id: "server", label: "Server" },
      { id: "app", label: "Application" },
      { id: "orders", label: "Orders" },
    ]);
    expect(answer.children).toEqual([]);
    expect(answer.outgoing).toEqual([
      { node: { id: "db", label: "Database" }, label: "SQL orders" },
      {
        node: { id: "email", label: "Email service" },
        label: "confirmation",
        tags: ["account", "order"],
      },
    ]);
    expect(answer.incoming).toEqual([
      { node: { id: "web", label: "Web routes" }, label: "checkout" },
    ]);
    expect(answer.fields).toMatchObject({ sub: "src/orders.ts", couples: ["db", "email"] });
    expect(answer.sources).toEqual(["src/orders.ts"]);
  });

  test("a node with children lists them, and the links that name it", () => {
    const answer = queryNode(sample, "data");

    expect(answer.children.map((c) => c.id)).toEqual(["db", "backup"]);
    expect(answer.incoming).toEqual([{ node: { id: "app", label: "Application" }, label: "SQL" }]);
    expect(answer.fields).not.toHaveProperty("children");
    expect(answer.sources).toEqual(["deploy/compose.yml", "deploy/compose.yml"]);
  });

  test("an id the map does not hold is refused", () => {
    expect(() => queryNode(sample, "nowhere")).toThrow(QueryError);
  });
});

describe("query.ts", () => {
  test("prints the node as JSON", async () => {
    const run = Bun.spawn([process.execPath, join(import.meta.dir, "query.ts"), SAMPLE, "backup"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, out] = await Promise.all([run.exited, new Response(run.stdout).text()]);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      path: [{ id: "server" }, { id: "data" }, { id: "backup" }],
    });
  });

  test("an unknown id exits 1 and says why", async () => {
    const run = Bun.spawn(
      [process.execPath, join(import.meta.dir, "query.ts"), SAMPLE, "nowhere"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const [code, error] = await Promise.all([run.exited, new Response(run.stderr).text()]);

    expect(code).toBe(1);
    expect(error).toContain("query: no node nowhere in the map");
  });
});
