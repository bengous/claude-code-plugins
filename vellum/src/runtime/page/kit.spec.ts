import { describe, expect, test } from "bun:test";

import type { DialogProps, PopoverProps } from "./kit.tsx";
import { Button, Chip, Handle } from "./kit.tsx";

describe("the kit owns its classes", () => {
  test("a chip takes no class at the call, and one forced in loses to the kit's", () => {
    // @ts-expect-error -- `ChipProps` omits `className`: a chip's tone is a prop, never a class spelled at the call.
    const chip = Chip({ className: "chip del", children: "x" });

    expect(chip.props.className).toBe("chip");
  });

  test("a button's extra class goes through `className`, which the kit joins to its own", () => {
    // @ts-expect-error -- `ButtonProps` takes `className`: a `class` would reach the DOM as an attribute of its own.
    const button = Button({ class: "lit", children: "x" });

    expect(Button({ className: "lit", children: "x" }).props.className).toBe("btn lit");
    expect(button.props.className).toBe("btn");
  });

  test("a popover closes: `onClose` is no option", () => {
    // @ts-expect-error -- `PopoverProps` requires `onClose`: a dialog Escape cannot close traps the keyboard.
    const trap: PopoverProps = { label: "New comment", children: "x" };

    expect("onClose" in trap).toBe(false);
  });

  test("a dialog closes: `onCancel` is no option", () => {
    // @ts-expect-error -- `DialogProps` requires `onCancel`: a modal Escape cannot close traps the page.
    const trap: DialogProps = { label: "Claude suggests a grill", children: "x" };

    expect("onCancel" in trap).toBe(false);
  });

  test("a handle's class names its side, and its accessible name is its label, else its name", () => {
    const folded = { open: false, controls: "panel", onToggle: () => {} };
    const rail = Handle({ ...folded, side: "left", name: "Documents" });
    const comments = Handle({ ...folded, side: "right", name: "Comments", label: "Comments (3)" });

    expect(rail.props.className).toBe("handle left");
    expect(comments.props.className).toBe("handle right");
    expect(rail.props["aria-expanded"]).toBe(false);
    expect(rail.props["aria-label"]).toBe("Documents");
    expect(comments.props["aria-label"]).toBe("Comments (3)");
  });
});
