import type { On } from "claude-code";

export function logs(on: On): string[] {
  const lines: string[] = [];

  on("ui.log", (_, e) => {
    lines.push(e.text);

    return { value: undefined };
  });

  return lines;
}
