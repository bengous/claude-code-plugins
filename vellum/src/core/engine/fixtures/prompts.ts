import type { On } from "claude-code";

/**
 * Every prompt submitted, as it is submitted. `holding` answers late, as the engine does for a
 * prompt submitted while a turn runs: the call resolves once that prompt's own turn starts.
 */
export function prompts(
  on: On,
  dropping?: () => string | undefined,
  holding?: () => Promise<void>,
): string[] {
  const texts: string[] = [];

  on("prompt.submit", async (_, e) => {
    const drop = dropping?.();

    if (drop !== undefined) return { drop };
    texts.push(e.text);
    await holding?.();

    return { text: e.text };
  });

  return texts;
}
