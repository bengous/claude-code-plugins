/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the boundary parser of a repository's `.claude/settings.json`: a file the factory did not write, read as far as its hooks and kept as it is beyond them. */

/** What merging the factory's hook entries into a settings file gives. */
export type SettingsMerge =
  | { readonly kind: "merged"; readonly text: string }
  | { readonly kind: "identical" }
  | { readonly kind: "refused"; readonly why: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandsOf(group: unknown): string[] {
  if (!isRecord(group) || !Array.isArray(group["hooks"])) return [];

  const hooks: unknown[] = group["hooks"];

  return hooks.flatMap((hook) =>
    isRecord(hook) && typeof hook["command"] === "string" ? [hook["command"]] : [],
  );
}

function parseObject(text: string, name: string): Json | string {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `${name} is not JSON: ${error instanceof Error ? error.message : String(error)}`;
  }

  return isRecord(parsed) ? parsed : `${name} is not a JSON object`;
}

/**
 * `current` with each hook group of `fragment` added under its event, unless a group there already runs the same
 * command. Everything else `current` holds stays as it is; a file whose hooks do not read is refused, never rewritten.
 */
export function mergeHooks(current: string | null, fragment: string): SettingsMerge {
  const wanted = parseObject(fragment, "the factory's hook entries");

  if (typeof wanted === "string" || !isRecord(wanted["hooks"])) {
    throw new Error(
      typeof wanted === "string" ? wanted : "the factory's hook entries hold no hooks",
    );
  }

  const settings = current === null ? {} : parseObject(current, ".claude/settings.json");

  if (typeof settings === "string") return { kind: "refused", why: settings };

  const existing = settings["hooks"] ?? {};

  if (!isRecord(existing)) {
    return { kind: "refused", why: ".claude/settings.json: hooks is not an object" };
  }

  const hooks = { ...existing };
  let added = false;

  for (const [event, groups] of Object.entries(wanted["hooks"])) {
    const present = hooks[event] ?? [];

    if (!Array.isArray(present) || !Array.isArray(groups)) {
      return { kind: "refused", why: `.claude/settings.json: hooks.${event} is not a list` };
    }

    const there: unknown[] = present;
    const running = new Set(there.flatMap((group) => commandsOf(group)));
    const missing = groups.filter((group) => !commandsOf(group).every((cmd) => running.has(cmd)));

    if (missing.length > 0) {
      hooks[event] = [...there, ...missing];
      added = true;
    }
  }

  return added
    ? { kind: "merged", text: `${JSON.stringify({ ...settings, hooks }, null, 2)}\n` }
    : { kind: "identical" };
}
