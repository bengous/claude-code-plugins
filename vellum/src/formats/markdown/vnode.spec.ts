/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures are branded ProjectPath literals and Preact vnodes read as records; the brand is the parser's to grant, and nothing here parses. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ComponentChildren, VNode } from "preact";
import { isValidElement, toChildArray } from "preact";

import type { GroupedDoc } from "../../runtime/protocol.ts";
import { toTree } from "./tree.ts";
import type { Sheet } from "./vnode.ts";
import { toVNodes } from "./vnode.ts";

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

function doc(path: string, mediaType: GroupedDoc["mediaType"] = "text/markdown"): GroupedDoc {
  return { path, mediaType, modified: 0, group: "artifact" } as never;
}

const SHEET: Sheet = {
  changes: null,
  docs: [doc(`${WIP}capture.png`, "image/png"), doc(`${WIP}screens/dialog.html`, "text/html")],
  plan: { doc: `${WIP}.review/v1.md`, workingCopy: `${WIP}plan.md` } as never,
};

/** The props a drawn node is read for. */
type Props = {
  readonly class?: string;
  readonly src?: string;
  readonly "data-path"?: string;
  readonly children?: ComponentChildren;
};

type Drawn = VNode<Props>;

/** Every vnode under `nodes`, depth first, whose tag is `tag`. */
function drawn(nodes: ComponentChildren, tag: string): Drawn[] {
  return toChildArray(nodes).flatMap((node) => {
    if (!isValidElement(node)) return [];
    const one = node as Drawn;
    const below = drawn(one.props.children, tag);

    return one.type === tag ? [one, ...below] : below;
  });
}

function draw(markdown: string, sheet: Sheet = SHEET): ComponentChildren {
  return toVNodes(toTree(markdown).children, sheet);
}

/** Bun has no `location`: a link's URL carries the token of a fake page, gone after each test. */
beforeEach(() => {
  Object.defineProperty(globalThis, "location", {
    value: { pathname: "/t/tok/" },
    configurable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

describe("a task list", () => {
  test("a done task's box is checked and disabled as booleans, and named after its item", () => {
    const [box] = drawn(draw("- [x] D1 agreed with the team\n"), "input");

    expect(box?.props).toMatchObject({
      checked: true,
      disabled: true,
      "aria-label": "D1 agreed with the team",
    });
  });

  test("a loose item's box is named after its paragraph, an item's box never after its nested list", () => {
    const [loose] = drawn(draw("- [x] D1 agreed\n\n- [ ] D2 open\n"), "input");
    const [nesting] = drawn(draw("- [ ] D3 split\n  - [ ] D3a\n"), "input");

    expect(loose?.props).toMatchObject({ "aria-label": "D1 agreed" });
    expect(nesting?.props).toMatchObject({ "aria-label": "D3 split" });
  });
});

describe("what a name reaches", () => {
  test("an image beside the plan is asked from its listed path, not the project root", () => {
    const [image] = drawn(draw("![the form](capture.png)"), "img");

    expect(image?.props).toMatchObject({ "data-path": `${WIP}capture.png` });
    expect(String(image?.props.src)).toContain(`/files/${WIP}capture.png`);
  });

  test("a name in backticks that reaches a document is a link to it", () => {
    const [link] = drawn(draw("See `screens/dialog.html` first."), "a");

    expect(link?.props).toMatchObject({ "data-path": `${WIP}screens/dialog.html` });
    expect(drawn([link], "code")).toHaveLength(1);
  });

  test("a name in backticks inside a link stays the link's, with no anchor nested", () => {
    const [link, ...more] = drawn(draw("[`screens/dialog.html`](screens/dialog.html)"), "a");

    expect(more).toHaveLength(0);
    expect(drawn([link], "code")).toHaveLength(1);
  });

  test("a name that reaches nothing, and code in a block, stay code", () => {
    expect(drawn(draw("Call `render()`.\n\n```ts\nconst x = 1;\n```\n"), "a")).toHaveLength(0);
  });
});

describe("a table", () => {
  test("is drawn in a box of its own that scrolls", () => {
    const [box] = drawn(draw("| a | b |\n|---|---|\n| 1 | 2 |\n"), "div");

    expect(box?.props.class).toBe("scroll-x");
    expect(drawn([box], "table")).toHaveLength(1);
  });
});
