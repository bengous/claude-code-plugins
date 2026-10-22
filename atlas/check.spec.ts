import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { AtlasMap, Lang, Link, Node } from "./atlas.ts";
import { checkMap, validate } from "./check.ts";
import { drawableOf } from "./drawable.ts";
import { DEEP } from "./fixtures/trees.ts";
import { THREADS_FILE, loadFolder } from "./folder.ts";
import { settingsOf } from "./settings.ts";
import { treeOf } from "./tree.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

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

  test("a container in both side columns is refused: only a leaf is drawn twice", () => {
    const both = withNode(MAP, "clients", (n) => ({ ...n, side: "both" }));

    expect(checkMap(both, CONFIG, THREADS)).toEqual([
      'node clients: side "both" is for an outside leaf',
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

describe("drawableOf", () => {
  test("answers the tree and the settings of a drawable map", () => {
    const { tree, settings } = drawableOf(MAP, CONFIG);

    expect([...tree.nodes.keys()]).toEqual([...TREE.nodes.keys()]);
    expect(settings).toEqual(SETTINGS);
  });
});
