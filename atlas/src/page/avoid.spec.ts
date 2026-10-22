import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

// libavoid fetches libavoid.wasm relative to the working directory, so the routing runs in a
// process started beside the installed package's file.
const WASM_DIR = dirname(Bun.resolveSync("libavoid-js", import.meta.dir));

const ROUTE = `
import { routeLinks } from ${JSON.stringify(join(import.meta.dir, "avoid.ts"))};
const sources = ["a", "b", "c", "d", "e", "f", "g"];
const boxes = new Map([
  ...sources.map((id, i) => [id, { x: 0, y: i * 60, w: 100, h: 40 }]),
  ["t", { x: 400, y: 160, w: 100, h: 40 }],
]);
const links = sources.map((id) => ({ from: id, to: "t" }));
const ends = async (pins) => (await routeLinks(boxes, [], links, pins)).map((r) => r.at(-1).join(" "));
console.log(JSON.stringify({ shared: await ends("shared"), exclusive: await ends("exclusive") }));
`;

type Ends = { readonly shared: readonly string[]; readonly exclusive: readonly string[] };

describe("routeLinks", () => {
  test("shared pins let arrows into one box end at one point; exclusive pins give each its own", async () => {
    const run = Bun.spawn([process.execPath, "-e", ROUTE], {
      cwd: WASM_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [code, out, error] = await Promise.all([
      run.exited,
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
    ]);

    expect(error).toBe("");
    expect(code).toBe(0);

    const ends: Ends = JSON.parse(out);

    expect(ends.shared).toHaveLength(7);
    expect(new Set(ends.shared).size).toBeLessThan(ends.shared.length);
    expect(new Set(ends.exclusive).size).toBe(ends.exclusive.length);
  });
});
