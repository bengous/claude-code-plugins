import { describe, expect, test } from "bun:test";

import type { Selection } from "../shared/wire.ts";
import {
  accepted,
  add,
  delivered,
  dropped,
  EMPTY,
  failed,
  remove,
  sending,
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
    { kind: "zone", box: { x: 0, y: 0, width: 400.4, height: 99.6 }, elements: [] },
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
    const tray = delivered(accepted(add(EMPTY, A), ["a"], 3), 3);

    expect(tray.status).toEqual({ kind: "delivered", seq: 3, count: 1 });
    expect(tray.sent).toEqual([]);
  });

  test("a delivery of an older batch leaves the status of the last one", () => {
    const tray = accepted(accepted(add(add(EMPTY, A), B), ["a"], 3), ["b"], 4);

    expect(delivered(tray, 3).status).toEqual({ kind: "sent", seq: 4, count: 1 });
  });

  test("a batch the session dropped comes back to the head of the batch", () => {
    const tray = dropped(add(accepted(add(EMPTY, A), ["a"], 3), B), 3, "refused");

    expect(tray.items).toEqual([A, B]);
    expect(statusText(tray.status)).toContain("Batch 3 was not delivered: refused.");
  });
});

test("summaryOf names each target by its last step, a zone by its size", () => {
  expect(summaryOf(SELECTION.targets)).toBe("img.logo, zone 400 × 100 (0 elements)");
});
