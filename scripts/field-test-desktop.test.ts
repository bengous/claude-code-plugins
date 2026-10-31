import { describe, expect, test } from "bun:test";

import {
  claudeWindows,
  keyArgs,
  linkOf,
  newSessionLink,
  pickWindow,
  pointerTarget,
} from "./field-test-desktop.ts";

/** `hyprctl clients -j` as it printed the main window, a popped-out session and a browser. */
const CLIENTS = [
  {
    address: "0x55be30f09c20",
    class: "Claude",
    title: "Claude",
    at: [1282, 28],
    size: [2556, 1410],
    workspace: { name: "1" },
  },
  {
    address: "0x55be31c7d6a0",
    class: "Claude",
    title: "Test cloud-pull : bouton de la bande",
    at: [2, 735],
    size: [1276, 703],
    workspace: { name: "1" },
  },
  { address: "0x1", class: "brave-browser", title: "Claude - Brave", at: [0, 0], size: [10, 10] },
];

describe("claudeWindows", () => {
  test("keeps Desktop's windows with their geometry, not a browser tab titled Claude", () => {
    expect(claudeWindows(CLIENTS).map((window) => [window.title, window.x, window.y])).toEqual([
      ["Claude", 1282, 28],
      ["Test cloud-pull : bouton de la bande", 2, 735],
    ]);
  });

  test("skips a client without geometry", () => {
    expect(claudeWindows([{ address: "0x2", class: "Claude", title: "Claude" }])).toEqual([]);
  });
});

describe("pickWindow", () => {
  const windows = claudeWindows(CLIENTS);

  test("defaults to the main window", () => {
    expect(pickWindow(windows)?.address).toBe("0x55be30f09c20");
  });

  test("finds a popped-out session by part of its title", () => {
    expect(pickWindow(windows, "bouton de la bande")?.address).toBe("0x55be31c7d6a0");
  });

  test("answers nothing for a title no window holds", () => {
    expect(pickWindow(windows, "absent")).toBeUndefined();
  });
});

describe("linkOf", () => {
  test("imports a CLI session by its uuid", () => {
    expect(linkOf("f407e488-6b88-45bc-8785-922532401de4")).toBe(
      "claude://resume?session=f407e488-6b88-45bc-8785-922532401de4",
    );
  });

  test("shows a Desktop session by its local id", () => {
    expect(linkOf("local_016f9de5-c7f5-48e4-83f1-94a792858f76")).toBe(
      "claude://claude.ai/epitaxy/local_016f9de5-c7f5-48e4-83f1-94a792858f76",
    );
  });

  test("passes a claude:// link as given, and refuses anything else", () => {
    expect(linkOf("claude://code/new")).toBe("claude://code/new");
    expect(linkOf("https://claude.ai")).toBeUndefined();
  });
});

describe("newSessionLink", () => {
  test("encodes the folder and the prompt", () => {
    expect(newSessionLink("/home/me/Work/repo", "cloud pull")).toBe(
      "claude://code/new?folder=%2Fhome%2Fme%2FWork%2Frepo&q=cloud+pull",
    );
  });

  test("is the bare page with neither", () => {
    expect(newSessionLink()).toBe("claude://code/new");
  });
});

describe("pointerTarget", () => {
  test("adds the window's origin and halves the sum for ydotool", () => {
    const [, popped] = claudeWindows(CLIENTS);

    if (popped === undefined) throw new Error("fixture lost its popped-out window");

    expect(pointerTarget(popped, { x: 375, y: 590 })).toEqual({ x: 189, y: 663 });
  });
});

describe("keyArgs", () => {
  test("presses then releases each key", () => {
    expect(keyArgs(["End", "Enter"])).toEqual(["107:1", "107:0", "28:1", "28:0"]);
  });

  test("names the keys it knows when given another", () => {
    expect(() => keyArgs(["F13"])).toThrow(/unknown key F13: one of Escape/u);
  });
});
