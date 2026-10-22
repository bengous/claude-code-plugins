import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Lang, Node } from "./atlas.ts";
import { checkMap, validate } from "./check.ts";
import { THREADS_FILE, loadFolder, planOf } from "./folder.ts";
import type { Brick, Plan } from "./model.ts";
import { settingsOf } from "./settings.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const PLAN = await planOf(SAMPLE);

const { map: MAP, config: CONFIG } = await loadFolder(SAMPLE);

const SETTINGS = settingsOf(CONFIG);

const THREADS: unknown = await Bun.file(join(SAMPLE, THREADS_FILE)).json();

const withOpen = (id: string, text: string): Plan => ({
  ...PLAN,
  nodes: PLAN.nodes.map((n): Brick =>
    n.id === "browser" ? { ...n, info: { ...n.info, open: [{ id, text }] } } : n,
  ),
});

describe("validate", () => {
  test("the plan itself is valid", () => {
    expect(validate(PLAN, SETTINGS, THREADS)).toEqual([]);
  });

  test("a coupling to a brick that does not exist is rejected", () => {
    const nodes = PLAN.nodes.map((n) =>
      n.id === "browser" ? { ...n, couples: ["no-such-brick"] } : n,
    );

    expect(validate({ ...PLAN, nodes }, SETTINGS, {})).toContain(
      "brick browser: couples unknown brick no-such-brick",
    );
  });

  test("an overview label that no brick arrow backs is rejected", () => {
    const edges = PLAN.edges.map((e) =>
      e.from === "z:app" && e.to === "email" ? { ...e, to: "browser" } : e,
    );

    expect(validate({ ...PLAN, edges }, SETTINGS, {})).toContain(
      "overview label z:app → browser: no brick arrow joins these boxes in that direction",
    );
  });

  const untagged = PLAN.edges.map((e) =>
    e.from === "orders" && e.to === "email" ? { from: e.from, to: e.to, label: e.label } : e,
  );

  test("an arrow into a third-party service without its tags is rejected when the tags require them", () => {
    expect(validate({ ...PLAN, edges: untagged }, SETTINGS, {})).toContain(
      "arrow orders → email: an arrow into a third-party service names its tags",
    );
  });

  test("an arrow into a third-party service without tags passes when the tags do not require them", () => {
    const optional = { ...SETTINGS, tags: { ...SETTINGS.tags, outside: "optional" as const } };

    expect(validate({ ...PLAN, edges: untagged }, optional, {})).toEqual([]);
  });

  test("a tag outside the config's tags is rejected", () => {
    const edges = PLAN.edges.map((e) =>
      e.from === "orders" && e.to === "email" ? { ...e, data: ["order", "invoice"] } : e,
    );

    expect(validate({ ...PLAN, edges }, SETTINGS, {})).toEqual([
      "arrow orders → email: tag invoice is not in the config's tags",
    ]);
  });

  test("a map whose config lists no tags refuses every tag", () => {
    const { tags: _, ...tagless } = CONFIG;

    expect(validate(PLAN, settingsOf(tagless), {})).toEqual([
      "arrow orders → email: tag account is not in the config's tags",
      "arrow orders → email: tag order is not in the config's tags",
    ]);
  });

  test("a tour that misses a node with children is rejected", () => {
    const zoneOrder = PLAN.zoneOrder.filter((id) => id !== "data");
    expect(validate({ ...PLAN, zoneOrder }, SETTINGS, {})).toContain(
      "tour misses data, a node with children",
    );
  });

  test("a tour that names a leaf is rejected", () => {
    const zoneOrder = [...PLAN.zoneOrder, "db"];
    expect(validate({ ...PLAN, zoneOrder }, SETTINGS, {})).toContain(
      "tour lists db, which is no node with children",
    );
  });

  test("an open id used twice is rejected", () => {
    expect(validate(withOpen("backup-restore-untested", "Un état."), SETTINGS, {})).toContain(
      "brick backup: open point backup-restore-untested: duplicate open id",
    );
  });

  test("an open id that is not kebab-case is rejected", () => {
    expect(validate(withOpen("Browser_Open", "Un état."), SETTINGS, {})).toContain(
      "brick browser: open point Browser_Open: the id must be kebab-case",
    );
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
    expect(validate(withOpen("browser-step", text), STEPS, {})).toContain(
      `brick browser: open point browser-step: "${word}" names a step; an open point describes a state`,
    );
  });

  test("a state that only looks like a step word passes", () => {
    expect(
      validate(
        withOpen("browser-state", "La migration 0026 reste en A10 et en I12, imprévu."),
        STEPS,
        {},
      ),
    ).toEqual([]);
  });

  test("without step words in the config, no text names a step", () => {
    expect(validate(withOpen("browser-step", "Rotation prévue en F2a."), SETTINGS, {})).toEqual([]);
  });

  test("a thread under an unknown open id is rejected", () => {
    expect(validate(PLAN, SETTINGS, { "no-such-point": [{ who: "agent", text: "x" }] })).toContain(
      "threads.json: thread for unknown open id no-such-point",
    );
  });

  test("a who outside the enumeration is rejected", () => {
    expect(
      validate(PLAN, SETTINGS, { "backup-restore-untested": [{ who: "codex", text: "x" }] }),
    ).toContain(
      'threads.json backup-restore-untested[0]: who must be one of human, agent, got "codex"',
    );
  });
});

const pinkBrowser = (n: Node): Node =>
  n.id === "browser"
    ? { ...n, color: "pink" }
    : n.children === undefined
      ? n
      : { ...n, children: n.children.map(pinkBrowser) };

describe("checkMap", () => {
  test("the sample map folder is valid", () => {
    expect(checkMap(MAP, CONFIG, THREADS)).toEqual([]);
  });

  test("a colour that is not a key of the palette is refused", () => {
    const root = { ...MAP.root, children: MAP.root.children.map(pinkBrowser) };

    expect(checkMap({ ...MAP, root }, CONFIG, THREADS)).toEqual([
      "node browser: color pink is not in the palette",
    ]);
  });

  test("a language the dictionary does not hold is refused", () => {
    // SAFETY: a language outside Lang, as a map folder's data can hold once it skips its typecheck.
    expect(checkMap(MAP, { ...CONFIG, lang: "de" as Lang }, THREADS)).toEqual([
      `lang "de": the page's words exist in fr, en`,
    ]);
  });

  test("a tag outside the config's tags is refused", () => {
    const links = MAP.links.map((l) =>
      l.to === "email" && l.tags !== undefined ? { ...l, tags: ["parcel"] } : l,
    );

    expect(checkMap({ ...MAP, links }, CONFIG, THREADS)).toEqual([
      "arrow orders → email: tag parcel is not in the config's tags",
    ]);
  });
});
