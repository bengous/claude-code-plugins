import { describe, expect, test } from "bun:test";

import { Button, Chip } from "./kit.tsx";

describe("the kit owns its classes", () => {
  test("a chip takes no class at the call, and one forced in loses to the kit's", () => {
    // @ts-expect-error -- `ChipProps` omits `class`: a chip's tone is a prop, never a class spelled at the call.
    const chip = Chip({ class: "chip del", children: "x" });

    expect(chip.props.class).toBe("chip");
  });

  test("a button's extra class goes through `class`, which the kit joins to its own", () => {
    // @ts-expect-error -- `ButtonProps` omits `className`: it would reach the DOM beside the kit's `class`.
    const button = Button({ className: "lit", children: "x" });

    expect(Button({ class: "lit", children: "x" }).props.class).toBe("btn lit");
    expect(button.props.class).toBe("btn");
  });
});
