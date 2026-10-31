import { describe, expect, test } from "bun:test";

import {
  claudeWindows,
  confirmationOf,
  isOnTarget,
  keyArgs,
  linkOf,
  logParts,
  newSessionLink,
  parseCursor,
  pickWindow,
  pointerTarget,
  scaleOf,
  wholeNumber,
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

  test("takes an uppercase uuid and sends it lowercase", () => {
    expect(linkOf("F407E488-6B88-45BC-8785-922532401DE4")).toBe(
      "claude://resume?session=f407e488-6b88-45bc-8785-922532401de4",
    );
  });
});

describe("confirmationOf", () => {
  test("matches both of Desktop's import lines for a uuid", () => {
    const expected = confirmationOf("f407e488-6b88-45bc-8785-922532401de4");

    expect(
      "Resume deep link: importing CLI session f407e488-6b88-45bc-8785-922532401de4",
    ).toContain(expected ?? "");
    expect(
      "CLI session f407e488-6b88-45bc-8785-922532401de4 already imported as local_f407e488",
    ).toContain(expected ?? "");
  });

  test("names the focus line for a Desktop session, nothing for a bare link", () => {
    expect(confirmationOf("local_abc")).toBe("setFocusedSession: sessionId=local_abc");
    expect(confirmationOf("claude://code/new")).toBeUndefined();
  });
});

describe("wholeNumber", () => {
  test("reads decimal digits alone", () => {
    expect(wholeNumber("375")).toBe(375);
    expect(wholeNumber("0")).toBe(0);
  });

  test("refuses the empty string, signs, decimals and words", () => {
    for (const text of ["", "-3", "1.5", "12abc", "<mark>", undefined]) {
      expect(wholeNumber(text)).toBeUndefined();
    }
  });
});

describe("parseCursor", () => {
  test("reads hyprctl cursorpos", () => {
    expect(parseCursor("2448, 1326\n")).toEqual({ x: 2448, y: 1326 });
  });

  test("refuses an error or a notice", () => {
    expect(parseCursor("error: no such dispatcher")).toBeUndefined();
    expect(parseCursor("")).toBeUndefined();
  });
});

describe("scaleOf", () => {
  test("derives the screen pixels per ydotool unit on each axis", () => {
    expect(scaleOf({ x: 200, y: 200 }, { x: 400, y: 400 })).toEqual({ x: 2, y: 2 });
  });

  test("refuses a move that landed at the origin", () => {
    expect(scaleOf({ x: 200, y: 200 }, { x: 0, y: 400 })).toBeUndefined();
  });
});

describe("isOnTarget", () => {
  test("holds within two pixels on both axes", () => {
    expect(isOnTarget({ x: 377, y: 1324 }, { x: 377, y: 1325 })).toBe(true);
  });

  test("fails when only the vertical axis is off", () => {
    expect(isOnTarget({ x: 377, y: 1439 }, { x: 377, y: 1325 })).toBe(false);
  });
});

describe("logParts", () => {
  const current = { file: "main.log", offset: 0, size: 900 };
  const rotated = { file: "main1.log", offset: 0, size: 5000 };

  test("reads the current log from the mark", () => {
    expect(logParts(400, current, rotated)).toEqual([{ file: "main.log", offset: 400 }]);
  });

  test("after a rotation, reads the rest of the old log, then the new one whole", () => {
    expect(logParts(4000, current, rotated)).toEqual([
      { file: "main1.log", offset: 4000 },
      { file: "main.log", offset: 0 },
    ]);
  });

  test("refuses a mark older than both logs", () => {
    expect(logParts(9000, current, rotated)).toBeUndefined();
    expect(logParts(4000, current, undefined)).toBeUndefined();
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
  test("adds the window's origin and divides by the measured scale", () => {
    const [, popped] = claudeWindows(CLIENTS);

    if (popped === undefined) throw new Error("fixture lost its popped-out window");

    expect(pointerTarget(popped, { x: 375, y: 590 }, { x: 2, y: 2 })).toEqual({ x: 189, y: 663 });
    expect(pointerTarget(popped, { x: 375, y: 590 }, { x: 1, y: 1.5 })).toEqual({
      x: 377,
      y: 883,
    });
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
