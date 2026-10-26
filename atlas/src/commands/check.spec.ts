import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEEP } from "../../fixtures/trees.ts";
import type { AtlasMap, Config, Lang, Link, Node } from "../model/atlas.ts";
import { mapCitations } from "../model/citations.ts";
import { drawableOf } from "../model/drawable.ts";
import { THREADS_FILE, loadFolder } from "../model/folder.ts";
import { settingsOf } from "../model/settings.ts";
import { SOURCE_CAP_BYTES } from "../model/sources.ts";
import { treeOf } from "../model/tree.ts";
import { checkCitations, checkMap, validate } from "./check.ts";

const SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "sample");

const { map: MAP, config: CONFIG } = await loadFolder(SAMPLE);

const TREE = treeOf(MAP);

const SETTINGS = settingsOf(CONFIG);

const THREADS: unknown = await Bun.file(join(SAMPLE, THREADS_FILE)).json();

const edit = (node: Node, change: (n: Node) => Node): Node => {
  const changed = change(node);

  return changed.children === undefined
    ? changed
    : { ...changed, children: changed.children.map((c) => edit(c, change)) };
};

const withNode = (map: AtlasMap, id: string, change: (n: Node) => Node): AtlasMap => ({
  ...map,
  root: {
    ...map.root,
    children: map.root.children.map((c) => edit(c, (n) => (n.id === id ? change(n) : n))),
  },
});

const withLinks = (map: AtlasMap, change: (l: Link) => Link): AtlasMap => ({
  ...map,
  links: map.links.map(change),
});

const withOpen = (id: string, text: string): AtlasMap =>
  withNode(MAP, "browser", (n) => ({ ...n, open: [{ id, text }] }));

const errorsOf = (map: AtlasMap, settings = SETTINGS): string[] =>
  validate(treeOf(map), settings, {});

describe("validate", () => {
  test("the sample is valid, and so is a map five levels deep", () => {
    expect(validate(TREE, SETTINGS, THREADS)).toEqual([]);
    expect(
      validate(
        treeOf(DEEP),
        settingsOf({ ...CONFIG, tags: { names: ["t1"], outside: "optional" } }),
        {},
      ),
    ).toEqual([]);
  });

  test("a brief on a leaf is rejected", () => {
    expect(errorsOf(withNode(MAP, "browser", (n) => ({ ...n, brief: ["x"] })))).toEqual([
      "node browser: brief is for a node with children",
    ]);
  });

  test("a rank on an outside node is rejected: its side places it", () => {
    expect(errorsOf(withNode(MAP, "clients", (n) => ({ ...n, rank: 0 })))).toEqual([
      "node clients: rank is for a node inside; an outside node's side places it",
    ]);
  });

  test("a rank from 0, on a container or a leaf, passes", () => {
    const server = withNode(MAP, "server", (n) => ({ ...n, rank: 0 }));
    const ranked = withNode(server, "browser", (n) => ({ ...n, rank: 3 }));

    expect(errorsOf(ranked)).toEqual([]);
  });

  test("a tour that misses a node with children, or names a leaf, is rejected", () => {
    const tour = ["clients", "server", "app", "db"];

    expect(errorsOf({ ...MAP, root: { ...MAP.root, tour } })).toEqual([
      "tour lists db, which is no node with children",
      "tour misses data, a node with children",
    ]);
  });

  const untagged = withLinks(MAP, (l) =>
    l.from === "orders" && l.to === "email" ? { from: l.from, to: l.to, label: l.label } : l,
  );

  test("a link into a third-party service without its tags is rejected when the tags require them", () => {
    expect(errorsOf(untagged)).toContain(
      "link orders → email: a link into a third-party service names its tags",
    );
  });

  test("a link into a third-party service without tags passes when the tags do not require them", () => {
    const optional = { ...SETTINGS, tags: { ...SETTINGS.tags, outside: "optional" as const } };

    expect(errorsOf(untagged, optional)).toEqual([]);
  });

  test("a link into an outside container, or into an outside leaf on the left, needs no tag", () => {
    const left = withLinks(MAP, (l) =>
      l.from === "browser" && l.to === "proxy"
        ? { from: "proxy", to: "browser", label: "pages" }
        : l,
    );

    expect(errorsOf(left)).toEqual([]);
  });

  test("a tag outside the config's tags is rejected", () => {
    const tagged = withLinks(MAP, (l) =>
      l.from === "orders" && l.to === "email" ? { ...l, tags: ["order", "invoice"] } : l,
    );

    expect(errorsOf(tagged)).toEqual([
      "link orders → email: tag invoice is not in the config's tags",
    ]);
  });

  test("a map whose config lists no tags refuses every tag", () => {
    const { tags: _, ...tagless } = CONFIG;

    expect(errorsOf(MAP, settingsOf(tagless))).toEqual([
      "link orders → email: tag account is not in the config's tags",
      "link orders → email: tag order is not in the config's tags",
    ]);
  });

  test("an unknown id in see, seams or traps is rejected on the root and on any node", () => {
    const root = { ...MAP, root: { ...MAP.root, seams: [["nowhere", "x"]] as const } };

    expect(errorsOf(root)).toEqual(["root: seams unknown id nowhere"]);

    const node = withNode(MAP, "db", (n) => ({ ...n, traps: [["gone", "x"]], see: ["lost"] }));

    expect(errorsOf(node)).toEqual([
      "node db: see unknown id lost",
      "node db: traps unknown id gone",
    ]);
  });

  test("an open id used twice is rejected", () => {
    expect(errorsOf(withOpen("backup-restore-untested", "Un état."))).toContain(
      "leaf backup: open point backup-restore-untested: duplicate open id",
    );
  });

  test("an open id that is not kebab-case is rejected", () => {
    expect(errorsOf(withOpen("Browser_Open", "Un état."))).toContain(
      "leaf browser: open point Browser_Open: the id must be kebab-case",
    );
  });

  test("a container's open point names it as a container", () => {
    const container = withNode(MAP, "data", (n) => ({ ...n, open: [{ id: "Data", text: "x" }] }));

    expect(errorsOf(container)).toEqual([
      "container data: open point Data: the id must be kebab-case",
    ]);
  });

  const STEPS = settingsOf({
    ...CONFIG,
    stepWords: [/\b[A-J][0-9][ab]?\b/u, /\b(?:prévu|pas fait|après l'étape|bientôt)/iu],
  });

  test.each([
    ["Réglé à l'étape <code>F2a</code>.", "F2a"],
    ["Corrigé après I1.", "I1"],
    ["Rotation prévue.", "prévu"],
    ["Contrôle pas fait.", "pas fait"],
    ["Sauvegarde Bientôt écrite.", "Bientôt"],
    ["Réglé après l'étape de la CI.", "après l'étape"],
  ])("an open point matching the config's step words is rejected: %s", (text, word) => {
    expect(errorsOf(withOpen("browser-step", text), STEPS)).toContain(
      `leaf browser: open point browser-step: "${word}" names a step; an open point describes a state`,
    );
  });

  test("a state that only looks like a step word passes", () => {
    expect(
      errorsOf(
        withOpen("browser-state", "La migration 0026 reste en A10 et en I12, imprévu."),
        STEPS,
      ),
    ).toEqual([]);
  });

  test("a step word with a g flag finds its word in every open point", () => {
    const twice = withNode(withOpen("browser-step", "Réglé en F2a."), "proxy", (n) => ({
      ...n,
      open: [{ id: "proxy-step", text: "Réglé en F2a." }],
    }));

    expect(errorsOf(twice, settingsOf({ ...CONFIG, stepWords: [/F2a/gu] }))).toEqual([
      'leaf browser: open point browser-step: "F2a" names a step; an open point describes a state',
      'leaf proxy: open point proxy-step: "F2a" names a step; an open point describes a state',
    ]);
  });

  test("without step words in the config, no text names a step", () => {
    expect(errorsOf(withOpen("browser-step", "Rotation prévue en F2a."))).toEqual([]);
  });

  test("a thread under an unknown open id is rejected", () => {
    expect(validate(TREE, SETTINGS, { "no-such-point": [{ who: "agent", text: "x" }] })).toContain(
      "threads.json: thread for unknown open id no-such-point",
    );
  });

  test("a who outside the enumeration is rejected", () => {
    expect(
      validate(TREE, SETTINGS, { "backup-restore-untested": [{ who: "codex", text: "x" }] }),
    ).toContain(
      'threads.json backup-restore-untested[0]: who must be one of human, agent, got "codex"',
    );
  });
});

describe("checkMap", () => {
  test("the sample map folder is valid", () => {
    expect(checkMap(MAP, CONFIG, THREADS)).toEqual([]);
  });

  test("a colour that is not a key of the palette is refused", () => {
    expect(
      checkMap(
        withNode(MAP, "browser", (n) => ({ ...n, color: "pink" })),
        CONFIG,
        THREADS,
      ),
    ).toEqual(["node browser: color pink is not in the palette"]);
  });

  test("a tree no view can show is refused with its reason", () => {
    expect(
      checkMap(
        withNode(MAP, "catalog", (n) => ({ ...n, id: "web" })),
        CONFIG,
        THREADS,
      ),
    ).toEqual(["node web: a second node has this id"]);
  });

  test("a language the dictionary does not hold is refused", () => {
    // SAFETY: a language outside Lang, as a map folder's data can hold once it skips its typecheck.
    expect(checkMap(MAP, { ...CONFIG, lang: "de" as Lang }, THREADS)).toEqual([
      `lang "de": the page's words exist in fr, en`,
    ]);
  });

  test("a palette key that cannot name a CSS custom property is refused", () => {
    const palette = { ...CONFIG.palette, "light blue": { light: "#00f", dark: "#88f" } };

    expect(checkMap(MAP, { ...CONFIG, palette }, THREADS)).toEqual([
      'palette key "light blue": a key is letters, digits, - and _',
    ]);
  });

  test("a rank that is not an integer from 0 is refused, as drawableOf refuses it", () => {
    expect(
      checkMap(
        withNode(MAP, "browser", (n) => ({ ...n, rank: -1 })),
        CONFIG,
        THREADS,
      ),
    ).toEqual([
      "node browser: rank -1 is not an integer from 0; give 0 to the first band, 1 to the next, or no rank",
    ]);
  });

  test("a container in both side columns is refused: only a leaf is drawn twice", () => {
    const both = withNode(MAP, "clients", (n) => ({ ...n, side: "both" }));

    expect(checkMap(both, CONFIG, THREADS)).toEqual([
      'node clients: side "both" is for an outside leaf',
    ]);
  });

  test("markup a panel would not keep is refused, naming each node and field", () => {
    const hostile = withNode(
      withNode(MAP, "orders", (n) => ({ ...n, lead: '<img src=x onerror="fetch(1)">' })),
      "db",
      (n) => ({ ...n, pitfalls: ['<code class="x">y</code> <em>ok</em>'] }),
    );

    expect(checkMap(hostile, CONFIG, THREADS)).toEqual([
      'node orders: lead: <img src=x onerror="fetch(1)"> is not markup a panel keeps (code, cite, b, i, em, strong, br, with no attribute)',
      'node db: pitfalls: <code class="x"> is not markup a panel keeps (code, cite, b, i, em, strong, br, with no attribute)',
    ]);
  });

  test("a tag outside the config's tags is refused", () => {
    const links = MAP.links.map((l) =>
      l.to === "email" && l.tags !== undefined ? { ...l, tags: ["parcel"] } : l,
    );

    expect(checkMap({ ...MAP, links }, CONFIG, THREADS)).toEqual([
      "link orders → email: tag parcel is not in the config's tags",
    ]);
  });
});

const CITATIONS = join(import.meta.dir, "..", "..", "fixtures", "citations");

const { map: CITED, config: CITED_CONFIG } = await loadFolder(CITATIONS);

const ROOT = join(CITATIONS, "repo");

const citing = (change: (n: Node) => Node): AtlasMap => withNode(CITED, "orders", change);

const checked = (map: AtlasMap, config: Config = CITED_CONFIG): string[] =>
  checkCitations(map, config, CITATIONS);

describe("checkCitations, with the Config's sources", () => {
  test("passes the fixture, whose every citation names lines of a file under its root", () => {
    expect(mapCitations(CITED).length).toBeGreaterThan(20);
    expect(checked(CITED)).toEqual([]);
  });

  test("fails a citation of a missing file, naming its node, its field and itself", () => {
    const gone = citing((n) => ({ ...n, lead: "Gone <cite>orders/gone.go:1</cite>." }));

    expect(checked(gone)).toEqual([
      `node orders: lead: orders/gone.go:1: no file orders/gone.go under the sources root ${ROOT}`,
    ]);
  });

  test("fails a line past the file's end", () => {
    const past = citing((n) => ({ ...n, lead: "Far <cite>orders/orders.go:9999</cite>." }));

    expect(checked(past)).toEqual([
      "node orders: lead: orders/orders.go:9999: 9999 ends past line 55, the last of orders/orders.go",
    ]);
  });

  test("fails a range ending past the file's end, alone in its list, in any field", () => {
    const io = [["Receives", "a cart <cite>orders/orders.go:3,50-56</cite>"]] as const;

    expect(checked(citing((n) => ({ ...n, io })))).toEqual([
      "node orders: io: orders/orders.go:3,50-56: 50-56 ends past line 55, the last of orders/orders.go",
    ]);
  });

  test("fails every citation under a root that does not exist", () => {
    const errors = checked(CITED, { ...CITED_CONFIG, sources: { root: "nowhere" } });
    const reason = `the sources root ${join(CITATIONS, "nowhere")} is not a folder`;

    expect(errors).toHaveLength(mapCitations(CITED).length);
    expect(errors[0]).toBe(`root: lead: cmd/shop/main.go:15-24: ${reason}`);
    expect(errors.every((error) => error.endsWith(`: ${reason}`))).toBe(true);
  });

  test("fails a citation that leads out of the root", () => {
    const out = citing((n) => ({ ...n, swap: "The map <cite>../map.ts:1</cite>." }));

    expect(checked(out)).toEqual([
      "node orders: swap: ../map.ts:1: ../map.ts is no path from the sources root down",
    ]);
  });

  test("fails, as the viewer refuses it, a cited file over the cap, binary, or that cannot be read", () => {
    const folder = mkdtempSync(join(tmpdir(), "atlas-check-sources-"));
    const repo = join(folder, "repo");

    try {
      mkdirSync(repo);
      writeFileSync(join(repo, "big.txt"), "a".repeat(SOURCE_CAP_BYTES + 1));
      writeFileSync(join(repo, "nul.bin"), Buffer.from([0x61, 0x00, 0x0a]));
      writeFileSync(join(repo, "locked.txt"), "locked\n", { mode: 0o000 });
      const lead = "<cite>big.txt:1</cite> <cite>nul.bin:1</cite> <cite>locked.txt:1</cite>";

      const errors = checkCitations(
        citing((n) => ({ ...n, lead })),
        CITED_CONFIG,
        folder,
      );

      expect(errors.filter((error) => error.startsWith("node orders: lead: "))).toEqual([
        `node orders: lead: big.txt:1: big.txt is over ${SOURCE_CAP_BYTES} bytes`,
        "node orders: lead: nul.bin:1: nul.bin is not a text file in UTF-8",
        ...(process.getuid?.() === 0
          ? []
          : [
              expect.stringMatching(
                /^node orders: lead: locked\.txt:1: locked\.txt cannot be read: EACCES/u,
              ),
            ]),
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("passes the fixture checked as a draft of it, its sources root the map's", () => {
    expect(checkCitations(CITED, CITED_CONFIG, join(CITATIONS, "drafts", "try"))).toEqual([]);
  });

  test("verifies no citation without sources", () => {
    const { sources: _, ...unsourced } = CITED_CONFIG;
    const gone = citing((n) => ({ ...n, lead: "Gone <cite>orders/gone.go:9999</cite>." }));

    expect(checked(gone, unsourced)).toEqual([]);
  });
});

describe("drawableOf", () => {
  test("answers the tree and the settings of a drawable map", () => {
    const { tree, settings } = drawableOf(MAP, CONFIG);

    expect([...tree.nodes.keys()]).toEqual([...TREE.nodes.keys()]);
    expect(settings).toEqual(SETTINGS);
  });

  test("refuses markup a panel would not keep, as the server asks before each build", () => {
    const hostile = withNode(MAP, "orders", (n) => ({ ...n, how: "<script>x</script>" }));

    expect(() => drawableOf(hostile, CONFIG)).toThrow(
      "node orders: how: <script> is not markup a panel keeps",
    );
  });

  test.each([
    [-1, "-1"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    ["1", '"1"'],
  ])("refuses a rank that is not an integer from 0, which no band holds: %p", (rank, shown) => {
    // SAFETY: a rank outside number, as a map folder's data can hold once it skips its typecheck.
    const ranked = withNode(MAP, "browser", (n) => ({ ...n, rank: rank as number }));

    expect(() => drawableOf(ranked, CONFIG)).toThrow(
      `node browser: rank ${shown} is not an integer from 0; give 0 to the first band, 1 to the next, or no rank`,
    );
  });
});
