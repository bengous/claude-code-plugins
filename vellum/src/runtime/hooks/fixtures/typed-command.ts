import type { CommandRunInput } from "claude-code";

/** A slash command as the person typed it at the composer. */
export function typedCommand(command: string): CommandRunInput {
  return {
    command,
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 160 },
  };
}
