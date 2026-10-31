import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import JOURNEYS_CONFIG from "../../fixtures/journeys/atlas.config.ts";
import JOURNEYS_MAP from "../../fixtures/journeys/map.ts";
import { DEEP } from "../../fixtures/trees.ts";
import type {
  AtlasMap,
  Config,
  Filled,
  Journey,
  Lang,
  Link,
  Node,
  Section,
  Step,
} from "../model/atlas.ts";
import { mapCitations } from "../model/citations.ts";
import { drawableOf } from "../model/drawable.ts";
import { THREADS_FILE, loadFolder } from "../model/folder.ts";
import { settingsOf } from "../model/settings.ts";
import { SOURCE_CAP_BYTES } from "../model/sources.ts";
import { treeOf } from "../model/tree.ts";
import { checkCitations, checkMap, validate } from "./check.ts";

const SAMPLE = join(import.meta.dir, "..", "..", "fixtures", "sample");

const JOURNEYS = join(import.meta.dir, "..", "..", "fixtures", "journeys");

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

const entry = (from: string, to: string, trigger = "Open the shop"): Step => ({
  from,
  to,
  trigger,
  kind: "manual",
});

const walk = (id: string, ...sections: Section[]): Journey => ({ id, label: id, sections });

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

  const PHASED = settingsOf({ ...CONFIG, phases: ["v1", "v2"] });

  const phased = (nodePhase: string, linkPhase: string): AtlasMap =>
    withLinks(
      withNode(MAP, "orders", (n) => ({ ...n, phase: nodePhase })),
      (l) => (l.from === "orders" && l.to === "db" ? { ...l, phase: linkPhase } : l),
    );

  test("a phase on a node or a link, among the config's phases, passes", () => {
    expect(errorsOf(phased("v2", "v1"), PHASED)).toEqual([]);
  });

  test("a phase the config's phases do not list is rejected, on a node and on a link", () => {
    expect(errorsOf(phased("v3", "V1"), PHASED)).toEqual([
      'node orders: phase "v3" is not in the config\'s phases (v1, v2); name one of them, or add it to the phases',
      'link orders → db: phase "V1" is not in the config\'s phases (v1, v2); name one of them, or add it to the phases',
    ]);
  });

  test("a phase on a map whose config lists no phases is rejected, on a node and on a link", () => {
    expect(errorsOf(phased("v1", "v1"))).toEqual([
      'node orders: phase "v1", but the config lists no phases; list the work phases in order in the config\'s phases, or remove this one',
      'link orders → db: phase "v1", but the config lists no phases; list the work phases in order in the config\'s phases, or remove this one',
    ]);
    expect(errorsOf(phased("v1", "v1"), settingsOf({ ...CONFIG, phases: [] }))).toHaveLength(2);
  });

  const withJourneys = (journeys: readonly Journey[], map: AtlasMap = MAP): AtlasMap => ({
    ...map,
    root: { ...map.root, journeys },
  });

  const CHECKOUT: Journey = walk("checkout", {
    label: "Checkout",
    steps: [
      { ...entry("browser", "proxy"), note: "The reader opens the shop." },
      { from: "proxy", to: "web" },
      { from: "web", to: "orders" },
      { from: "orders", to: "db" },
    ],
  });

  const DEEP_SETTINGS = settingsOf({ ...CONFIG, tags: { names: ["t1"], outside: "optional" } });

  const NO_LINK =
    "no link of the map joins them; a step follows a link from its from to its to, or a two-headed one either way";

  test("a journey whose steps each follow a link, from a node its section reached, passes", () => {
    expect(errorsOf(withJourneys([CHECKOUT]))).toEqual([]);

    const across = walk("across-depths", {
      label: "Across depths",
      steps: [
        entry("a1", "a3"),
        { from: "a3", to: "a6" },
        { from: "a6", to: "X" },
        { from: "X", to: "a2" },
      ],
    });

    expect(errorsOf(withJourneys([across], DEEP), DEEP_SETTINGS)).toEqual([]);
  });

  test("a step follows a two-headed link either way, a one-way link only its own way", () => {
    const twoWays = walk("two-ways", { label: "Back", steps: [entry("B", "A")] });
    const upstream = walk("upstream", { label: "Up", steps: [entry("proxy", "browser")] });

    expect(errorsOf(withJourneys([twoWays], DEEP), DEEP_SETTINGS)).toEqual([]);
    expect(errorsOf(withJourneys([upstream]))).toEqual([
      `journey upstream: step 1 (Up), proxy → browser: ${NO_LINK}`,
    ]);
  });

  test("a step joined only through a pair a view lifts from deeper links is refused", () => {
    // The root's view draws server → email from app → email; the storage's draws app → db, a
    // ghost to a card, from orders → db.
    const boxes = walk("boxes", { label: "Boxes", steps: [entry("server", "email")] });
    const ghost = walk("ghost", { label: "Ghost", steps: [entry("app", "db")] });

    expect(errorsOf(withJourneys([boxes, ghost]))).toEqual([
      `journey boxes: step 1 (Boxes), server → email: ${NO_LINK}`,
      `journey ghost: step 1 (Ghost), app → db: ${NO_LINK}`,
    ]);
  });

  test("a step starts at any node its section reached, or anywhere as an entry", () => {
    const branches = walk("branches", {
      label: "Browse then buy",
      steps: [
        entry("browser", "proxy"),
        { from: "proxy", to: "web" },
        { from: "web", to: "catalog" },
        { from: "web", to: "orders" },
        { from: "catalog", to: "db" },
        entry("app", "email", "Every night"),
      ],
    });

    expect(errorsOf(withJourneys([branches]))).toEqual([]);
  });

  test("a step that is no entry and starts at a node its section has not reached is refused, a section reaching nothing of another's", () => {
    const jumps = walk(
      "jumps",
      {
        label: "Order",
        steps: [entry("browser", "proxy"), { from: "web", to: "orders" }],
      },
      {
        label: "Store",
        steps: [entry("orders", "db"), { from: "proxy", to: "web" }],
      },
    );

    expect(errorsOf(withJourneys([jumps]))).toEqual([
      "journey jumps: step 2 (Order), web → orders: starts at web, which its section has not reached; a step starts where its section has been, or is an entry",
      "journey jumps: step 4 (Store), proxy → web: starts at proxy, which its section has not reached; a step starts where its section has been, or is an entry",
    ]);
  });

  test("a section that does not open on an entry is refused, and only for that", () => {
    const opened = walk(
      "opened",
      { label: "Order", steps: [entry("browser", "proxy")] },
      { label: "Store", steps: [{ from: "orders", to: "db" }] },
    );

    expect(errorsOf(withJourneys([opened]))).toEqual([
      "journey opened: step 2 (Store), orders → db: a section opens with an entry, a step with a trigger and a kind",
    ]);
  });

  test("an entry whose trigger names nothing is refused", () => {
    const silent = walk("silent", {
      label: "Order",
      steps: [
        entry("browser", "proxy", ""),
        { from: "proxy", to: "web" },
        entry("web", "orders", " "),
      ],
    });

    expect(errorsOf(withJourneys([silent]))).toEqual([
      "journey silent: step 1 (Order), browser → proxy: an entry's trigger names what sets it off",
      "journey silent: step 3 (Order), web → orders: an entry's trigger names what sets it off",
    ]);
  });

  test("a step whose carries or when names nothing is refused", () => {
    const blank = walk("blank", {
      label: "Order",
      steps: [
        { ...entry("browser", "proxy"), carries: "", when: "the shop is open" },
        { from: "proxy", to: "web", carries: "a request", when: " " },
        { from: "web", to: "orders", carries: "  ", when: "" },
      ],
    });

    expect(errorsOf(withJourneys([blank]))).toEqual([
      "journey blank: step 1 (Order), browser → proxy: a step's carries names the data's form",
      "journey blank: step 2 (Order), proxy → web: a step's when names its condition",
      "journey blank: step 3 (Order), web → orders: a step's carries names the data's form",
      "journey blank: step 3 (Order), web → orders: a step's when names its condition",
    ]);
  });

  test("a step back follows a link set from its to to its from; one with its ends swapped by mistake is refused", () => {
    const back = walk("back", {
      label: "Round trip",
      steps: [entry("browser", "proxy"), { from: "proxy", to: "browser", back: true }],
    });

    const swapped = walk("swapped", {
      label: "Round trip",
      steps: [entry("browser", "proxy"), { from: "browser", to: "proxy", back: true }],
    });

    expect(errorsOf(withJourneys([back]))).toEqual([]);
    expect(errorsOf(withJourneys([swapped]))).toEqual([
      "journey swapped: step 2 (Round trip), browser → proxy: no link of the map runs from proxy to browser; a step with back follows a link the other way",
    ]);
  });

  test("a journey id used twice, or not kebab-case, is refused", () => {
    const shouting: Journey = { ...CHECKOUT, id: "Check_out" };

    expect(errorsOf(withJourneys([CHECKOUT, shouting, CHECKOUT]))).toEqual([
      "journey Check_out: the id must be kebab-case",
      "journey checkout: a second journey has this id",
    ]);
  });

  test("a journey with no section, a section without a label or without a step, is refused", () => {
    const empty = walk("empty");

    const hollow = walk(
      "hollow",
      { label: "Order", steps: [entry("browser", "proxy")] },
      { label: " ", steps: [entry("web", "orders")] },
      { label: "Store", steps: [] },
    );

    expect(errorsOf(withJourneys([empty, hollow]))).toEqual([
      "journey empty: no section; a journey has one section at least",
      "journey hollow: section 2: no label",
      "journey hollow: section 3 (Store): no step; a section has one step at least",
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

/**
 * A map written as a map.ts writes it, `as const`, refuses in the typecheck through Filled the
 * empty texts check refuses: the line under `@ts-expect-error` is what must not compile, and the
 * line after it runs, to say what check makes of that map.
 */
describe("Filled, on a map written as const", () => {
  test("a section's empty label does not compile", () => {
    const map = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "visit",
            label: "Visit",
            sections: [
              {
                label: "",
                steps: [{ from: "browser", to: "proxy", trigger: "Open", kind: "manual" }],
              },
            ],
          },
        ],
      },
    } as const satisfies AtlasMap;

    // @ts-expect-error -- Filled turns a section's empty label into never.
    const typed = map satisfies Filled<typeof map>;

    expect(checkMap(typed, CONFIG, THREADS)).toEqual(["journey visit: section 1: no label"]);
  });

  test("an entry's empty trigger does not compile", () => {
    const map = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "visit",
            label: "Visit",
            sections: [
              {
                label: "Open",
                steps: [{ from: "browser", to: "proxy", trigger: "", kind: "manual" }],
              },
            ],
          },
        ],
      },
    } as const satisfies AtlasMap;

    // @ts-expect-error -- Filled turns an entry's empty trigger into never.
    const typed = map satisfies Filled<typeof map>;

    expect(checkMap(typed, CONFIG, THREADS)).toEqual([
      "journey visit: step 1 (Open), browser → proxy: an entry's trigger names what sets it off",
    ]);
  });

  test("a step's empty carries does not compile", () => {
    const map = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "visit",
            label: "Visit",
            sections: [
              {
                label: "Open",
                steps: [
                  { from: "browser", to: "proxy", trigger: "Open", kind: "manual", carries: "" },
                ],
              },
            ],
          },
        ],
      },
    } as const satisfies AtlasMap;

    // @ts-expect-error -- Filled turns a step's empty carries into never.
    const typed = map satisfies Filled<typeof map>;

    expect(checkMap(typed, CONFIG, THREADS)).toEqual([
      "journey visit: step 1 (Open), browser → proxy: a step's carries names the data's form",
    ]);
  });

  test("a step's empty when does not compile", () => {
    const map = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "visit",
            label: "Visit",
            sections: [
              {
                label: "Open",
                steps: [
                  { from: "browser", to: "proxy", trigger: "Open", kind: "manual", when: "" },
                ],
              },
            ],
          },
        ],
      },
    } as const satisfies AtlasMap;

    // @ts-expect-error -- Filled turns a step's empty when into never.
    const typed = map satisfies Filled<typeof map>;

    expect(checkMap(typed, CONFIG, THREADS)).toEqual([
      "journey visit: step 1 (Open), browser → proxy: a step's when names its condition",
    ]);
  });

  test("filled texts compile, and so do a journey's empty label and a step's empty note, which check leaves alone", () => {
    const map = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "visit",
            label: "",
            sections: [
              {
                label: "Open",
                steps: [
                  {
                    from: "browser",
                    to: "proxy",
                    trigger: "Open",
                    kind: "manual",
                    carries: "a request",
                    when: "the shop is up",
                    note: "",
                  },
                ],
              },
            ],
          },
        ],
      },
    } as const satisfies AtlasMap;

    const typed = map satisfies Filled<typeof map>;

    expect(checkMap(typed, CONFIG, THREADS)).toEqual([]);
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

  test("a journey's step on an unknown node is refused, naming the journey, the step and its section", () => {
    const broken: AtlasMap = {
      ...MAP,
      root: {
        ...MAP.root,
        journeys: [
          {
            id: "broken",
            label: "Broken",
            sections: [{ label: "Order", steps: [{ from: "nowhere", to: "proxy" }] }],
          },
        ],
      },
    };

    expect(checkMap(broken, CONFIG, THREADS)).toEqual([
      "journey broken: step 1 (Order), nowhere → proxy: no node nowhere",
    ]);
  });

  test("a journey in the format before sections is refused, not thrown", () => {
    const old: Pick<Journey, "id" | "label"> & { readonly steps?: readonly Step[] } = {
      id: "old",
      label: "Old",
      steps: [{ from: "browser", to: "proxy" }],
    };

    // SAFETY: a journey without sections, as a map folder's data holds before its typecheck runs.
    const journeys = [old as Journey];
    const map: AtlasMap = { ...MAP, root: { ...MAP.root, journeys } };

    expect(checkMap(map, CONFIG, THREADS)).toEqual(["journey old: sections is not a list"]);
  });

  test("the journeys fixture is valid: its three journeys, their entries, a return, a condition", async () => {
    const threads: unknown = await Bun.file(join(JOURNEYS, THREADS_FILE)).json();

    expect(checkMap(JOURNEYS_MAP, JOURNEYS_CONFIG, threads)).toEqual([]);
  });

  test("a language the dictionary does not hold is refused", () => {
    // SAFETY: a language outside Lang, as a map folder's data can hold once it skips its typecheck.
    expect(checkMap(MAP, { ...CONFIG, lang: "de" as Lang }, THREADS)).toEqual([
      `lang "de": the page's words exist in fr, en`,
    ]);
  });

  test("a work phase listed twice, or empty, is refused, naming the phases field", () => {
    expect(checkMap(MAP, { ...CONFIG, phases: ["v1", "v2", "v1"] }, THREADS)).toEqual([
      'phases: "v1" is listed twice; list each work phase once',
    ]);
    expect(checkMap(MAP, { ...CONFIG, phases: ["v1", ""] }, THREADS)).toEqual([
      'phases: "" names no phase; give each work phase a name, or remove this one',
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

  test("a <cite> that looks like a citation but reads as none is named, with or without sources", () => {
    const cited = withNode(MAP, "orders", (n) => ({
      ...n,
      lead: "<cite>a.ts:0</cite> <cite>a.ts:1, 3</cite> <cite>redis:6379</cite>",
      swap: "<cite>b/c.go:9-3</cite>",
    }));

    expect(checkMap(cited, CONFIG, THREADS)).toEqual([
      "node orders: lead: a.ts:0 reads as no citation: lines count from 1: 0",
      "node orders: swap: b/c.go:9-3 reads as no citation: the range 9-3 runs backwards",
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

  test("fails a root that does not exist in one line, naming it and the citations left unchecked", () => {
    const count = mapCitations(CITED).length;

    expect(checked(CITED, { ...CITED_CONFIG, sources: { root: "nowhere" } })).toEqual([
      `sources: the sources root ${join(CITATIONS, "nowhere")} is not a folder; ${count} citations left unchecked`,
    ]);
  });

  test("fails a citation that leads out of the root", () => {
    const out = citing((n) => ({ ...n, swap: "The map <cite>../map.ts:1</cite>." }));

    expect(checked(out)).toEqual([
      "node orders: swap: ../map.ts:1: ../map.ts is no path from the sources root down",
    ]);
  });

  test("passes the lines of a cited file over the cap or not in UTF-8, and fails one binary or that cannot be read", () => {
    const folder = mkdtempSync(join(tmpdir(), "atlas-check-sources-"));
    const repo = join(folder, "repo");

    try {
      mkdirSync(repo);
      writeFileSync(join(repo, "big.txt"), `${"a".repeat(SOURCE_CAP_BYTES)}\nlast\n`);
      writeFileSync(join(repo, "latin1.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
      writeFileSync(join(repo, "nul.bin"), Buffer.from([0x61, 0x00, 0x0a]));
      writeFileSync(join(repo, "locked.txt"), "locked\n", { mode: 0o000 });

      const lead = [
        "<cite>big.txt:1-2</cite> <cite>big.txt:3</cite>",
        "<cite>latin1.txt:1</cite> <cite>latin1.txt:2</cite>",
        "<cite>nul.bin:1</cite> <cite>locked.txt:1</cite>",
      ].join(" ");

      const errors = checkCitations(
        citing((n) => ({ ...n, lead })),
        CITED_CONFIG,
        folder,
      );

      expect(errors.filter((error) => error.startsWith("node orders: lead: "))).toEqual([
        "node orders: lead: big.txt:3: 3 ends past line 2, the last of big.txt",
        "node orders: lead: latin1.txt:2: 2 ends past line 1, the last of latin1.txt",
        "node orders: lead: nul.bin:1: nul.bin is a binary file: it holds a NUL byte",
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

  test("reads each cited file once, however many citations name it", () => {
    const opened = spyOn(fs, "openSync");

    try {
      checked(CITED);
      const paths = new Set(mapCitations(CITED).map(({ citation }) => citation.path));

      expect(mapCitations(CITED).length).toBeGreaterThan(paths.size);
      expect(opened).toHaveBeenCalledTimes(paths.size);
    } finally {
      opened.mockRestore();
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
