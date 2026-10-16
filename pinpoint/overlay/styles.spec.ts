import { expect, test } from "bun:test";

import { keptStyles } from "./styles.ts";

function reader(values: Readonly<Record<string, string>>): (property: string) => string {
  return (property) => values[property] ?? "";
}

test("keeps the font and what differs from the browser's default", () => {
  const styles = keptStyles(
    reader({
      "font-weight": "500",
      "font-size": "13px",
      "line-height": "16px",
      "font-family": "system-ui",
      color: "rgb(29, 36, 48)",
      "background-color": "rgba(0, 0, 0, 0)",
      padding: "6px 12px",
      margin: "0px",
      "border-radius": "4px",
      display: "inline-flex",
      opacity: "1",
      border: "1px solid rgb(200, 200, 200)",
    }),
  );

  expect(styles).toEqual([
    ["font", "500 13px/16px system-ui"],
    ["color", "rgb(29, 36, 48)"],
    ["padding", "6px 12px"],
    ["border-radius", "4px"],
    ["display", "inline-flex"],
    ["border", "1px solid rgb(200, 200, 200)"],
  ]);
});

test("a border that draws nothing, or whose sides differ, is left out", () => {
  expect(
    keptStyles(reader({ border: "0px none rgb(0, 0, 0)" })).map(([property]) => property),
  ).not.toContain("border");
  expect(keptStyles(reader({ border: "" })).map(([property]) => property)).not.toContain("border");
});
