import type { On } from "claude-code";

export function statuses(on: On): (string | undefined)[] {
  const line: (string | undefined)[] = [];

  on("ui.status", (_, e) => {
    line.push(e.text);

    return { value: undefined };
  });

  return line;
}
