import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { validate } from "./check.ts";
import { THREADS_FILE, planOf } from "./folder.ts";
import type { Brick, Plan } from "./model.ts";

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const PLAN = await planOf(SAMPLE);

const THREADS: unknown = await Bun.file(join(SAMPLE, THREADS_FILE)).json();

const withOpen = (id: string, text: string): Plan => ({
  ...PLAN,
  nodes: PLAN.nodes.map((n): Brick =>
    n.id === "browser" ? { ...n, info: { ...n.info, open: [{ id, text }] } } : n,
  ),
});

describe("validate", () => {
  test("the plan itself is valid", () => {
    expect(validate(PLAN, THREADS)).toEqual([]);
  });

  test("a coupling to a brick that does not exist is rejected", () => {
    const nodes = PLAN.nodes.map((n) =>
      n.id === "browser" ? { ...n, couples: ["no-such-brick"] } : n,
    );

    expect(validate({ ...PLAN, nodes }, {})).toContain(
      "brick browser: couples unknown brick no-such-brick",
    );
  });

  test("an overview label that no brick arrow backs is rejected", () => {
    const edges = PLAN.edges.map((e) =>
      e.from === "z:app" && e.to === "email" ? { ...e, to: "browser" } : e,
    );

    expect(validate({ ...PLAN, edges }, {})).toContain(
      "overview label z:app → browser: no brick arrow joins these boxes in that direction",
    );
  });

  test("an arrow into a third-party service without its tags is rejected", () => {
    const edges = PLAN.edges.map((e) =>
      e.from === "orders" && e.to === "email" ? { from: e.from, to: e.to, label: e.label } : e,
    );

    expect(validate({ ...PLAN, edges }, {})).toContain(
      "arrow orders → email: an arrow into a third-party service names its tags",
    );
  });

  test("a zone missing from the zone order is rejected", () => {
    const zoneOrder = PLAN.zoneOrder.filter((id) => id !== "data");
    expect(validate({ ...PLAN, zoneOrder }, {})).toContain("zone data missing from zoneOrder");
  });

  test("an open id used twice is rejected", () => {
    expect(validate(withOpen("backup-restore-untested", "Un état."), {})).toContain(
      "brick backup: open point backup-restore-untested: duplicate open id",
    );
  });

  test("an open id that is not kebab-case is rejected", () => {
    expect(validate(withOpen("Browser_Open", "Un état."), {})).toContain(
      "brick browser: open point Browser_Open: the id must be kebab-case",
    );
  });

  test.each([
    ["Réglé à l'étape <code>F2a</code>.", "F2a"],
    ["Corrigé après I1.", "I1"],
    ["Rotation prévue.", "prévu"],
    ["Contrôle pas fait.", "pas fait"],
    ["Sauvegarde Bientôt écrite.", "Bientôt"],
    ["Réglé après l'étape de la CI.", "après l'étape"],
  ])("an open point naming a step is rejected: %s", (text, word) => {
    expect(validate(withOpen("browser-step", text), {})).toContain(
      `brick browser: open point browser-step: "${word}" names a step; an open point describes a state`,
    );
  });

  test("a state that only looks like a step word passes", () => {
    expect(
      validate(withOpen("browser-state", "La migration 0026 reste en A10 et en I12, imprévu."), {}),
    ).toEqual([]);
  });

  test("a thread under an unknown open id is rejected", () => {
    expect(validate(PLAN, { "no-such-point": [{ who: "agent", text: "x" }] })).toContain(
      "threads.json: thread for unknown open id no-such-point",
    );
  });

  test("a who outside the enumeration is rejected", () => {
    expect(validate(PLAN, { "backup-restore-untested": [{ who: "codex", text: "x" }] })).toContain(
      'threads.json backup-restore-untested[0]: who must be one of human, agent, got "codex"',
    );
  });
});
