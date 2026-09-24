import { describe, expect, test } from "bun:test";

import type { NameSources } from "./describe.ts";
import { nameFrom, openingTag, roleOf } from "./describe.ts";

describe("roleOf", () => {
  test("a role attribute wins, by its first token", () => {
    expect(roleOf("div", [["role", "tab button"]])).toBe("tab");
  });

  test("none and presentation leave no role", () => {
    expect(roleOf("button", [["role", "presentation"]])).toBe("");
    expect(roleOf("li", [["role", "none"]])).toBe("");
  });

  test("a link needs its href", () => {
    expect(roleOf("a", [["href", "#pricing"]])).toBe("link");
    expect(roleOf("a", [])).toBe("");
  });

  test("an input takes its type's role, a text field when the type says none", () => {
    expect(roleOf("input", [["type", "checkbox"]])).toBe("checkbox");
    expect(roleOf("input", [["type", "Submit"]])).toBe("button");
    expect(roleOf("input", [])).toBe("textbox");
    expect(roleOf("input", [["type", "hidden"]])).toBe("");
  });

  test("an input whose type HTML does not know is a text field, as the browser draws it", () => {
    expect(roleOf("input", [["type", "foo"]])).toBe("textbox");
    expect(roleOf("input", [["type", " text"]])).toBe("textbox");
    expect(roleOf("input", [["type", "password"]])).toBe("");
  });

  test("a select is a combobox, a listbox once it shows several options", () => {
    expect(roleOf("select", [])).toBe("combobox");
    expect(roleOf("select", [["multiple", ""]])).toBe("listbox");
    expect(roleOf("select", [["size", "4"]])).toBe("listbox");
  });

  test("an image with an empty alt is decoration", () => {
    expect(roleOf("img", [["alt", "Floor plan"]])).toBe("img");
    expect(roleOf("img", [["alt", ""]])).toBe("");
  });

  test("a tag with no role of its own has none", () => {
    expect(roleOf("div", [["class", "card"]])).toBe("");
  });
});

const BLANK: NameSources = {
  ariaLabelledBy: "",
  ariaLabel: "",
  native: "",
  content: "",
  title: "",
  placeholder: "",
};

describe("nameFrom", () => {
  test("aria-labelledby, then aria-label, the host's label, the content, title, placeholder", () => {
    const all = {
      ariaLabelledBy: "By id",
      ariaLabel: "Settings",
      native: "Site",
      content: "Save",
      title: "Tip",
      placeholder: "Hint",
    };

    expect(nameFrom("button", all)).toBe("By id");
    expect(nameFrom("button", { ...all, ariaLabelledBy: "" })).toBe("Settings");
    expect(nameFrom("button", { ...all, ariaLabelledBy: "", ariaLabel: "" })).toBe("Site");
    expect(nameFrom("button", { ...BLANK, content: "Save", title: "Tip" })).toBe("Save");
    expect(nameFrom("button", { ...BLANK, title: "Tip", placeholder: "Hint" })).toBe("Tip");
    expect(nameFrom("textbox", { ...BLANK, placeholder: "Hint" })).toBe("Hint");
  });

  test("a role its content does not name takes no name from it: a card's text is its quote", () => {
    expect(nameFrom("", { ...BLANK, content: "Pro — $29/mo" })).toBe("");
    expect(nameFrom("", { ...BLANK, content: "Pro — $29/mo", title: "Pro plan" })).toBe("Pro plan");
  });

  test("a source of spaces is no name", () => {
    expect(nameFrom("button", { ...BLANK, ariaLabel: "  \n ", title: "Tip" })).toBe("Tip");
  });

  test("a name is collapsed and cut as a quote is, at 120 characters", () => {
    expect(nameFrom("heading", { ...BLANK, content: "  Option\n    D  " })).toBe("Option D");
    expect(nameFrom("link", { ...BLANK, content: "x".repeat(200) })).toHaveLength(120);
  });

  test("the cut counts characters, so an emoji at the limit is kept whole", () => {
    const heading = `${"a".repeat(119)}😀tail`;

    expect(nameFrom("heading", { ...BLANK, content: heading })).toBe(`${"a".repeat(119)}😀`);
  });
});

describe("openingTag", () => {
  test("the tag and its attributes in the order the element holds them", () => {
    const gear = [
      ["class", "btn gear-btn"],
      ["type", "button"],
      ["aria-haspopup", "dialog"],
      ["aria-label", "Settings"],
      ["id", "open-settings"],
      ["title", "Settings"],
    ] as const;

    expect(openingTag("button", gear)).toBe(
      '<button class="btn gear-btn" type="button" aria-haspopup="dialog" aria-label="Settings" id="open-settings" title="Settings">',
    );
  });

  test("an empty value is the attribute's name alone; a quote mark in a value is escaped", () => {
    const attributes = [
      ["disabled", ""],
      ["value", 'Say "hi"'],
    ] as const;

    expect(openingTag("input", attributes)).toBe('<input disabled value="Say &quot;hi&quot;">');
  });

  test("a value's whitespace is one space, so the tag holds on one line", () => {
    expect(openingTag("div", [["class", "card\n    wide"]])).toBe('<div class="card wide">');
  });

  test("a value past 80 characters is cut", () => {
    const style = `color: red; ${"x".repeat(100)}`;

    expect(openingTag("div", [["style", style]])).toBe(`<div style="${style.slice(0, 80)}…">`);
  });

  test("a value cut at an emoji keeps the emoji whole", () => {
    const title = `${"b".repeat(79)}😀tail`;

    expect(openingTag("p", [["title", title]])).toBe(`<p title="${"b".repeat(79)}😀…">`);
  });

  test("a tag past 300 characters is cut, and says so before its end", () => {
    const attributes = Array.from(
      { length: 20 },
      (_, at) => [`data-n${at}`, "y".repeat(20)] as const,
    );

    const tag = openingTag("div", attributes);

    expect(tag).toHaveLength(300);
    expect(tag).toEndWith("…>");
    expect(tag).toStartWith('<div data-n0="yyyy');
  });
});
