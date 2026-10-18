import { describe, expect, test } from "bun:test";

import type { Selection } from "../shared/wire.ts";
import {
  accepted,
  add,
  awaits,
  EMPTY,
  failed,
  givenUp,
  type HeldTarget,
  imaged,
  type Item,
  LEFT,
  previewOf,
  ready,
  remove,
  restored,
  sending,
  sendText,
  settle,
  statusText,
  summaryOf,
  WAITING,
} from "./tray.ts";

const SELECTION: Selection = {
  label: "Too big",
  note: "",
  targets: [
    {
      kind: "element",
      element: {
        selector: "body > header > img.logo",
        role: "img",
        name: "Logo",
        heading: "",
        openingTag: '<img class="logo" alt="Logo">',
        text: "",
        box: { x: 0, y: 0, width: 120, height: 40 },
        styles: [],
      },
    },
    {
      kind: "zone",
      box: { x: 0, y: 0, width: 400.4, height: 99.6 },
      elements: [],
      image: { failed: "no canvas" },
    },
  ],
  page: {
    url: "http://localhost:5173/",
    title: "",
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 0 },
  },
  context: null,
};

const A = { id: "a", selection: SELECTION };

const B = { id: "b", selection: { ...SELECTION, label: null, note: "b" } };

const [LOGO, ZONE] = SELECTION.targets;

if (LOGO?.kind !== "element" || ZONE?.kind !== "zone") {
  throw new Error("the fixture is an element, then a zone");
}

/** A selection whose zone's image is on its way, as the batch holds it from the add. */
const AWAITED: HeldTarget[] = [LOGO, { ...ZONE, image: WAITING }];

const W: Item = { id: "w", selection: { ...SELECTION, targets: AWAITED } };

describe("the batch", () => {
  test("adds and removes items", () => {
    const tray = add(add(EMPTY, A), B);

    expect(tray.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(remove(tray, "a").items).toEqual([B]);
  });

  test("items the server took leave the batch; the others stay", () => {
    const tray = accepted(sending(add(add(EMPTY, A), B), 1), ["b"], 7);

    expect(tray.items).toEqual([A]);
    expect(tray.status).toEqual({ kind: "sent", seq: 7, count: 1 });
  });

  test("a send that failed keeps every item", () => {
    const tray = failed(sending(add(EMPTY, A), 1), "no server");

    expect(tray.items).toEqual([A]);
    expect(statusText(tray.status)).toBe("Not sent: no server. The selections stay here.");
  });

  test("a delivery of the last batch says so", () => {
    const tray = settle(accepted(add(EMPTY, A), ["a"], 3), { seq: 3, outcome: "delivered" });

    expect(tray.status).toEqual({ kind: "delivered", seq: 3, count: 1 });
    expect(tray.sent).toEqual([]);
  });

  test("a delivery of an older batch leaves the status of the last one", () => {
    const tray = accepted(accepted(add(add(EMPTY, A), B), ["a"], 3), ["b"], 4);

    expect(settle(tray, { seq: 3, outcome: "delivered" }).status).toEqual({
      kind: "sent",
      seq: 4,
      count: 1,
    });
  });

  test("a batch the session dropped comes back to the head of the batch", () => {
    const tray = settle(add(accepted(add(EMPTY, A), ["a"], 3), B), {
      seq: 3,
      outcome: "dropped",
      reason: "refused",
    });

    expect(tray.items).toEqual([A, B]);
    expect(tray.sent).toEqual([]);
    expect(statusText(tray.status)).toContain("Batch 3 was not delivered: refused.");
  });

  test("a batch the server no longer knows leaves the sent ones, said once", () => {
    const tray = settle(accepted(add(EMPTY, A), ["a"], 3), { seq: 3, outcome: "unknown" });

    expect(tray.sent).toEqual([]);
    expect(tray.items).toEqual([]);
    expect(statusText(tray.status)).toBe("Batch 3: the server no longer knows what became of it.");
  });

  test("a reloaded tray says its last batch still waiting", () => {
    const kept = accepted(accepted(add(add(EMPTY, A), B), ["a"], 3), ["b"], 4);

    expect(restored({ items: [], sent: kept.sent }).status).toEqual({
      kind: "sent",
      seq: 4,
      count: 1,
    });
    expect(restored({ items: [A], sent: [] })).toEqual({ ...EMPTY, items: [A] });
  });

  test("a batch still pending changes nothing", () => {
    const tray = accepted(add(EMPTY, A), ["a"], 3);

    expect(settle(tray, { seq: 3, outcome: "pending" })).toBe(tray);
  });

  test("an outcome of a batch this tab did not send changes nothing", () => {
    const tray = add(accepted(add(EMPTY, A), ["a"], 3), B);

    expect(settle(tray, { seq: 4, outcome: "delivered" })).toBe(tray);
    expect(settle(tray, { seq: 4, outcome: "dropped", reason: "refused" })).toBe(tray);
    expect(settle(tray, { seq: 4, outcome: "unknown" })).toBe(tray);
  });
});

describe("a zone's image on its way", () => {
  test("the image that comes in goes on its zone alone; the others are kept", () => {
    const tray = imaged(add(add(EMPTY, W), A), "w", 1, { id: "img" });

    expect(awaits(add(EMPTY, W), "w", 1)).toBe(true);
    expect(tray.items[0]?.selection.targets).toEqual([LOGO, { ...ZONE, image: { id: "img" } }]);
    expect(tray.items[1]).toEqual(A);
    expect(awaits(tray, "w", 1)).toBe(false);
  });

  test("an image nobody awaits changes nothing: a card removed, an element, one already in", () => {
    const tray = add(add(EMPTY, W), A);

    expect(imaged(tray, "gone", 1, { id: "img" })).toBe(tray);
    expect(imaged(tray, "w", 0, { id: "img" })).toBe(tray);
    expect(imaged(tray, "a", 1, { id: "img" })).toBe(tray);
    expect(imaged(imaged(tray, "w", 1, { id: "img" }), "w", 1, { failed: "late" })).toEqual(
      imaged(tray, "w", 1, { id: "img" }),
    );
  });

  test("the images given up say why; one already in is kept, and a tray with none to give up is itself", () => {
    const tray = givenUp(add(add(EMPTY, W), A), ["w", "a"], "too late");

    expect(tray.items[0]?.selection.targets[1]).toEqual({ ...ZONE, image: { failed: "too late" } });
    expect(tray.items[1]).toEqual(A);
    expect(givenUp(tray, ["w", "a"], "again")).toBe(tray);
  });

  test("a reloaded tray gives up the images its page took with it", () => {
    expect(restored({ items: [W, A], sent: [] }).items).toEqual([
      {
        ...W,
        selection: { ...W.selection, targets: [LOGO, { ...ZONE, image: { failed: LEFT } }] },
      },
      A,
    ]);
  });

  test("ready hands the server a selection whose images are in, and refuses one still waiting", () => {
    expect(ready(A.selection)).toEqual(SELECTION);
    expect(() => ready(W.selection)).toThrow("before its image was in");
  });
});

test("summaryOf names each target by its last step, a zone by its size, and says an image on its way", () => {
  expect(summaryOf(SELECTION.targets)).toBe("img.logo, zone 400 × 100 (0 elements)");
  expect(summaryOf(AWAITED)).toBe("img.logo, zone 400 × 100 (0 elements, image on its way)");
});

test("sendText names Ctrl+Enter only while pointing: with pointing off it is the app's", () => {
  expect(sendText(2, true)).toBe("Send (2) · Ctrl+Enter");
  expect(sendText(2, false)).toBe("Send (2)");
});

test("previewOf draws each page box where the scroll puts it, whatever the scroll at its pick or at the add", () => {
  const selection: Selection = {
    ...SELECTION,
    targets: [
      {
        kind: "element",
        element: { ...LOGO.element, box: { x: 100, y: 150, width: 120, height: 40 } },
      },
      {
        kind: "zone",
        box: { x: 300, y: 1150, width: 200, height: 60 },
        elements: [],
        image: { failed: "no canvas" },
      },
    ],
    page: { ...SELECTION.page, scroll: { x: 0, y: 800 } },
  };

  expect(previewOf(selection, { x: 0, y: 300 })).toEqual([
    { x: 100, y: -150, width: 120, height: 40 },
    { x: 300, y: 850, width: 200, height: 60 },
  ]);
});
