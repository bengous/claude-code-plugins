import { describe, expect, test } from "bun:test";

import {
  buildMap,
  type Graph,
  judge,
  LEVEL,
  MapError,
  type MapConfig,
  movedPath,
  previewPage,
  renderPage,
  reportLines,
  resolveBands,
} from "./map.ts";

const GRAPH: Graph = {
  root: "shop",
  unit: "lines",
  nodes: [
    { path: "core/app.py", size: 100 },
    { path: "core/db.py", size: 50 },
    { path: "orders/api.py", size: 10 },
    { path: "orders/store.py", size: 80 },
    { path: "billing/pay.py", size: 40 },
    { path: "migrations/0001.py", size: 30 },
    { path: "migrations/0002.py", size: 20 },
    { path: "pkg/__init__.py", size: 0 },
  ],
  edges: [
    ["core/app.py", "orders/store.py"],
    ["orders/store.py", "core/db.py"],
    ["billing/pay.py", "orders/api.py"],
    ["billing/pay.py", "orders/store.py"],
    ["migrations/0002.py", "migrations/0001.py"],
    ["migrations/0001.py", "core/db.py"],
    ["orders/store.py", "core/db.py"],
  ],
};

const LAYERED: MapConfig = {
  views: [
    {
      id: "today",
      bands: [
        { label: "modules", dirs: ["orders", "billing"], columns: true },
        { label: "core", dirs: ["core"] },
      ],
      rules: { layers: true, contracts: [{ band: "modules", files: ["api.py"] }] },
    },
  ],
};

describe("movedPath", () => {
  test("a folder destination keeps what follows the pattern's fixed prefix", () => {
    const hits = [0, 0];

    expect(movedPath("core/app.py", [["core/{app,admin}.py", "app/"]], hits)).toBe("app/app.py");
    expect(movedPath("src/core/a/b.ts", [["src/core/**", "kernel/"]], hits)).toBe("kernel/a/b.ts");
    expect(movedPath("src/x.ts", [["src/**", "./"]], hits)).toBe("x.ts");
  });

  test("a file destination is the new full path, the first match wins, and hits are counted", () => {
    const hits = [0, 0];

    const moves = [
      ["a/*.py", "b/renamed.py"],
      ["a/**", "c/"],
    ] as const;

    expect(movedPath("a/x.py", moves, hits)).toBe("b/renamed.py");
    expect(movedPath("a/d/y.py", moves, hits)).toBe("c/d/y.py");
    expect(movedPath("z.py", moves, hits)).toBe("z.py");
    expect(hits).toEqual([1, 1]);
  });
});

describe("resolveBands", () => {
  test("the longest folder wins, and files outside every band land in a last band with a note", () => {
    const notes: string[] = [];
    const view = { id: "v", bands: [{ dirs: ["a"] }, { dirs: ["a/b"] }] };
    const { bands, slots } = resolveBands(view, ["a/x.ts", "a/b/y.ts", "c/z.ts", null], notes);

    expect(slots).toEqual([[0, 0], [1, 0], [2, 0], null]);
    expect(bands.at(-1)?.dirs).toEqual(["c"]);
    expect(notes).toHaveLength(1);
  });

  test("without declared bands, one band of columns, one per top folder, and no note", () => {
    const notes: string[] = [];
    const { bands, slots } = resolveBands({ id: "v" }, ["a/x.ts", "b/y.ts", "root.ts"], notes);

    expect(bands).toEqual([{ label: "", dirs: [".", "a", "b"], columns: true }]);
    expect(slots).toEqual([
      [0, 1],
      [0, 2],
      [0, 0],
    ]);
    expect(notes).toEqual([]);
  });
});

describe("judge", () => {
  const rules = {
    bands: [{ dirs: ["app"] }, { dirs: ["orders", "billing"] }, { dirs: ["kernel"] }],
    contracts: [{ band: 1, files: ["api.py"], level: LEVEL.warn }],
    overrides: [{ from: "kernel/**", to: "kernel/legacy.py", verdict: "bad" as const }],
    layers: true,
  };

  test("an override wins over every other rule", () => {
    expect(judge(rules, ["kernel/a.py", 2, 0], ["kernel/legacy.py", 2, 0])).toBe(LEVEL.bad);
  });

  test("two files of one folder are ok", () => {
    expect(judge(rules, ["orders/a.py", 1, 0], ["orders/b.py", 1, 0])).toBe(LEVEL.ok);
  });

  test("between two folders of a band with a contract, only the contract file is ok", () => {
    expect(judge(rules, ["billing/pay.py", 1, 1], ["orders/api.py", 1, 0])).toBe(LEVEL.ok);
    expect(judge(rules, ["billing/pay.py", 1, 1], ["orders/store.py", 1, 0])).toBe(LEVEL.warn);
  });

  test("with layers, downward is ok and upward is bad", () => {
    expect(judge(rules, ["app/main.py", 0, 0], ["kernel/db.py", 2, 0])).toBe(LEVEL.ok);
    expect(judge(rules, ["kernel/db.py", 2, 0], ["app/main.py", 0, 0])).toBe(LEVEL.bad);
  });
});

describe("buildMap", () => {
  test("judges every link and reports per view", () => {
    const { data, report } = buildMap(GRAPH, LAYERED);
    const counts = report.views[0]?.counts;

    expect(report.links).toBe(6);
    expect(counts).toEqual([3, 1, 2]);
    expect(data.meta.root).toBe("shop/");
    expect(data.views[0]?.judges).toBe(true);
    expect(report.views[0]?.worst[0]).toEqual(["billing/pay.py", 1]);
  });

  test("a link is kept once, and drop and collapse reshape the files and their links", () => {
    const { data, report } = buildMap(GRAPH, {
      drop: [{ match: "**/__init__.py", maxSize: 1 }],
      collapse: [{ match: "migrations/**", into: "migrations/all", label: "all/" }],
    });

    const group = data.nodes.find((node) => node.g !== undefined);

    expect(report.files).toBe(5);
    expect(group).toEqual({ s: 50, g: 2, gl: "all/" });
    expect(report.links).toBe(5);
    expect(data.views[0]?.judges).toBe(false);
  });

  test("moves, files to create and notes for what the graph does not back", () => {
    const { data, report } = buildMap(GRAPH, {
      splits: { "ghost.py": ["a"] },
      views: [
        {
          id: "proposal",
          moves: [
            ["core/app.py", "app/"],
            ["nothing/*", "x/"],
          ],
          new: [{ path: "billing/api.py", why: "a contract" }],
        },
      ],
    });

    const paths = data.place[0]?.flatMap((slot) => (slot === null ? [] : [slot[0]]));

    expect(paths).toContain("app/app.py");
    expect(paths).toContain("billing/api.py");
    expect(data.nodes.at(-1)).toEqual({ s: 0, new: "a contract" });
    expect(report.views[0]?.moved).toBe(1);
    expect(report.notes).toHaveLength(2);
  });

  test("two files moved onto one path, or an unknown band, is an error", () => {
    expect(() =>
      buildMap(GRAPH, { views: [{ id: "v", moves: [["core/*.py", "core/same.py"]] }] }),
    ).toThrow(MapError);
    expect(() =>
      buildMap(GRAPH, {
        views: [{ id: "v", rules: { contracts: [{ band: "missing", files: ["api.py"] }] } }],
      }),
    ).toThrow(MapError);
  });

  test("starts on the named view, else on the last one", () => {
    const views = [{ id: "a" }, { id: "b" }];

    expect(buildMap(GRAPH, { views }).data.meta.start).toBe(1);
    expect(buildMap(GRAPH, { views, start: "a" }).data.meta.start).toBe(0);
  });
});

describe("renderPage", () => {
  const template =
    '<title>x</title><link rel="stylesheet" href="old"><style>/*EXTRA-CSS*/</style><script>const D=/*DATA*/null;</script>';

  test("lays in the data, the escaped title, the fonts and the CSS", () => {
    const { data } = buildMap(GRAPH, { title: "A </script> & B" });
    const html = renderPage(template, data, { name: "Shop <map>", fonts: "new", css: "body{}" });

    expect(html).toContain("<title>Shop &lt;map></title>");
    expect(html).toContain('href="new"');
    expect(html).toContain("<style>body{}</style>");
    expect(html).not.toContain("A </script>");
    expect(html).toContain(String.raw`A <\/script>`);
  });

  test("refuses a template without the data placeholder", () => {
    const { data } = buildMap(GRAPH, {});

    expect(() => renderPage("<title>x</title>", data, {})).toThrow(MapError);
  });

  test("the preview wraps the page in its own document", () => {
    expect(previewPage("<p>x</p>")).toStartWith("<!doctype html>");
  });
});

test("reportLines names notes, counts and the worst files", () => {
  const { report } = buildMap(GRAPH, LAYERED);
  const lines = reportLines(report);

  expect(lines[0]).toBe(
    '  note: view "today": 3 file(s) fit no band, shown in "other": migrations, pkg',
  );
  expect(lines[1]).toBe('  view "today": ok 3, warn 1, bad 2');
  expect(lines[2]).toBe(
    "    most links to fix: billing/pay.py (1), core/app.py (1), migrations/0001.py (1)",
  );
});
