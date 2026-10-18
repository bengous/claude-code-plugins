import { describe, expect, test } from "bun:test";

import type { Selection } from "../shared/wire.ts";
import {
  accepted,
  add,
  EMPTY,
  failed,
  previewOf,
  remove,
  restored,
  sending,
  sendText,
  settle,
  statusText,
  summaryOf,
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

test("summaryOf names each target by its last step, a zone by its size", () => {
  expect(summaryOf(SELECTION.targets)).toBe("img.logo, zone 400 × 100 (0 elements)");
});

test("sendText names Ctrl+Enter only while pointing: with pointing off it is the app's", () => {
  expect(sendText(2, true)).toBe("Send (2) · Ctrl+Enter");
  expect(sendText(2, false)).toBe("Send (2)");
});

test("previewOf draws each page box where the scroll puts it, whatever the scroll at its pick or at the add", () => {
  const [logo] = SELECTION.targets;

  if (logo?.kind !== "element") throw new Error("the fixture starts with an element");

  const selection: Selection = {
    ...SELECTION,
    targets: [
      {
        kind: "element",
        element: { ...logo.element, box: { x: 100, y: 150, width: 120, height: 40 } },
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
