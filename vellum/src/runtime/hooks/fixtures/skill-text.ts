import type { On } from "claude-code";

export function skillText(on: On): void {
  on("skill.prompt", () => ({ text: "t" }));
}
