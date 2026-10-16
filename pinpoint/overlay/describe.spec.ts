import { describe, expect, test } from "bun:test";

import {
  cut,
  levelOf,
  nameFrom,
  type NameSources,
  openingTag,
  roleOf,
  TEXT_LIMIT,
} from "./describe.ts";

const NONE: NameSources = {
  ariaLabelledBy: "",
  ariaLabel: "",
  native: "",
  content: "",
  title: "",
  placeholder: "",
};

describe("roleOf", () => {
  test("an explicit role wins, its first token; none and presentation are no role", () => {
    expect(roleOf("div", [["role", "Tab menuitem"]])).toBe("tab");
    expect(roleOf("button", [["role", "presentation"]])).toBe("");
  });

  test("a link needs an href; an input takes its type's role", () => {
    expect(roleOf("a", [])).toBe("");
    expect(roleOf("a", [["href", "/x"]])).toBe("link");
    expect(roleOf("input", [["type", "checkbox"]])).toBe("checkbox");
    expect(roleOf("input", [["type", "password"]])).toBe("");
    expect(roleOf("input", [])).toBe("textbox");
  });

  test("a select is a combobox unless it shows several options; a decorative image has none", () => {
    expect(roleOf("select", [])).toBe("combobox");
    expect(roleOf("select", [["size", "4"]])).toBe("listbox");
    expect(roleOf("img", [["alt", ""]])).toBe("");
    expect(roleOf("img", [["alt", "Logo"]])).toBe("img");
  });
});

describe("levelOf", () => {
  test("h1 to h6 by their number; an element that is no heading has none", () => {
    expect(levelOf("h3", [])).toBe(3);
    expect(levelOf("p", [])).toBeNull();
    expect(levelOf("h2", [["role", "presentation"]])).toBeNull();
  });

  test("role heading by its aria-level, 2 without one", () => {
    expect(levelOf("div", [["role", "heading"]])).toBe(2);
    expect(
      levelOf("div", [
        ["role", "heading"],
        ["aria-level", "4"],
      ]),
    ).toBe(4);
  });
});

describe("nameFrom", () => {
  test("the first source that says something, in the order of the computation", () => {
    expect(nameFrom("button", { ...NONE, ariaLabel: "Close", content: "×" })).toBe("Close");
    expect(nameFrom("textbox", { ...NONE, title: "Email", placeholder: "you@x" })).toBe("Email");
  });

  test("the content names only a role it names, whitespace collapsed", () => {
    expect(nameFrom("button", { ...NONE, content: "  Save\n changes " })).toBe("Save changes");
    expect(nameFrom("main", { ...NONE, content: "the whole page" })).toBe("");
  });

  test("a long name is cut", () => {
    expect([...nameFrom("heading", { ...NONE, content: "a".repeat(500) })]).toHaveLength(
      TEXT_LIMIT + 1,
    );
  });
});

describe("openingTag", () => {
  test("spells the tag on one line, an empty value as its name alone", () => {
    expect(
      openingTag("input", [
        ["type", "checkbox"],
        ["checked", ""],
      ]),
    ).toBe('<input type="checkbox" checked>');
  });

  test("a long value is cut and a quote escaped", () => {
    const tag = openingTag("div", [["data-x", `"${"v".repeat(200)}`]]);

    expect(tag.startsWith('<div data-x="&quot;vvv')).toBe(true);
    expect(tag).toContain("…");
  });
});

test("cut counts by code point and marks what it cut", () => {
  expect(cut("ab😀cd", 3)).toBe("ab😀…");
  expect(cut("abc", 3)).toBe("abc");
});
