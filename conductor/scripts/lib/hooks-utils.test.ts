/**
 * Tests for hooks-utils.ts
 */

import { describe, test, expect } from "bun:test";
import {
  PLUGIN_MARKER,
  isPluginHook,
  removePluginHooks,
  mergeHooks,
  countPluginHooks,
  type HookConfig,
  type MatcherConfig,
} from "./hooks-utils";

function createHook(description: string, command = "echo test"): HookConfig {
  return {
    type: "command",
    command,
    timeout: 10,
    description,
  };
}

function createMatcher(matcher: string, hooks: HookConfig[]): MatcherConfig {
  return { matcher, hooks };
}

describe("PLUGIN_MARKER", () => {
  test("contains identifying text", () => {
    expect(PLUGIN_MARKER).toContain("conductor plugin");
  });
});

describe("isPluginHook", () => {
  test("returns true for hook with plugin marker", () => {
    const hook = createHook(`My hook ${PLUGIN_MARKER}`);
    expect(isPluginHook(hook)).toBe(true);
  });

  test("returns false for hook without plugin marker", () => {
    const hook = createHook("User installed hook");
    expect(isPluginHook(hook)).toBe(false);
  });

  test("returns false for undefined description", () => {
    const hook = { type: "command", command: "test", timeout: 10 } as HookConfig;
    expect(isPluginHook(hook)).toBe(false);
  });

  test("returns false for empty description", () => {
    const hook = createHook("");
    expect(isPluginHook(hook)).toBe(false);
  });

  test("handles marker at start of description", () => {
    const hook = createHook(`${PLUGIN_MARKER} hook`);
    expect(isPluginHook(hook)).toBe(true);
  });

  test("handles marker at end of description", () => {
    const hook = createHook(`Some hook ${PLUGIN_MARKER}`);
    expect(isPluginHook(hook)).toBe(true);
  });
});

describe("removePluginHooks", () => {
  test("removes plugin hooks from matchers", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User hook"),
        createHook(`Plugin hook ${PLUGIN_MARKER}`),
      ]),
    ];

    const result = removePluginHooks(matchers);

    expect(result.length).toBe(1);
    expect(result[0]!.hooks.length).toBe(1);
    expect(result[0]!.hooks[0]!.description).toBe("User hook");
  });

  test("removes matcher entirely if all hooks are plugin hooks", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [
        createHook(`Hook 1 ${PLUGIN_MARKER}`),
        createHook(`Hook 2 ${PLUGIN_MARKER}`),
      ]),
    ];

    const result = removePluginHooks(matchers);

    expect(result.length).toBe(0);
  });

  test("preserves matchers with only user hooks", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Bash", [createHook("User hook 1"), createHook("User hook 2")]),
    ];

    const result = removePluginHooks(matchers);

    expect(result.length).toBe(1);
    expect(result[0]!.hooks.length).toBe(2);
  });

  test("handles multiple matchers", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User task hook"),
        createHook(`Plugin task hook ${PLUGIN_MARKER}`),
      ]),
      createMatcher("Bash", [createHook(`Plugin bash hook ${PLUGIN_MARKER}`)]),
      createMatcher("*", [createHook("Global user hook")]),
    ];

    const result = removePluginHooks(matchers);

    expect(result.length).toBe(2);
    const taskMatcher = result.find((m) => m.matcher === "Task");
    const globalMatcher = result.find((m) => m.matcher === "*");
    expect(taskMatcher).toBeDefined();
    expect(taskMatcher!.hooks.length).toBe(1);
    expect(globalMatcher).toBeDefined();
    expect(globalMatcher!.hooks.length).toBe(1);
    expect(result.find((m) => m.matcher === "Bash")).toBeUndefined();
  });

  test("returns input unchanged if not an array", () => {
    // @ts-expect-error - testing runtime behavior
    const result = removePluginHooks("not an array");
    // @ts-expect-error - result type is string at runtime for non-array input
    expect(result).toBe("not an array");
  });

  test("returns empty array for empty input", () => {
    const result = removePluginHooks([]);
    expect(result).toEqual([]);
  });

  test("does not mutate original array", () => {
    const original: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User hook"),
        createHook(`Plugin hook ${PLUGIN_MARKER}`),
      ]),
    ];
    const originalLength = original[0]!.hooks.length;

    removePluginHooks(original);

    expect(original[0]!.hooks.length).toBe(originalLength);
  });
});

describe("mergeHooks", () => {
  test("returns plugin hooks when existing is undefined", () => {
    const plugin: MatcherConfig[] = [
      createMatcher("Task", [createHook(`Plugin ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(undefined, plugin);

    expect(result).toEqual(plugin);
  });

  test("returns plugin hooks when existing is not an array", () => {
    const plugin: MatcherConfig[] = [
      createMatcher("Task", [createHook(`Plugin ${PLUGIN_MARKER}`)]),
    ];

    // @ts-expect-error - testing runtime behavior with invalid input
    const result = mergeHooks("not an array", plugin);

    expect(result).toStrictEqual(plugin);
  });

  test("merges into same matcher", () => {
    const existing: MatcherConfig[] = [
      createMatcher("Task", [createHook("User hook")]),
    ];
    const plugin: MatcherConfig[] = [
      createMatcher("Task", [createHook(`Plugin ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(existing, plugin);

    expect(result.length).toBe(1);
    expect(result[0]!.matcher).toBe("Task");
    expect(result[0]!.hooks.length).toBe(2);
  });

  test("adds new matcher", () => {
    const existing: MatcherConfig[] = [
      createMatcher("Task", [createHook("User task hook")]),
    ];
    const plugin: MatcherConfig[] = [
      createMatcher("*", [createHook(`Plugin global ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(existing, plugin);

    expect(result.length).toBe(2);
    expect(result.find((m) => m.matcher === "Task")).toBeDefined();
    expect(result.find((m) => m.matcher === "*")).toBeDefined();
  });

  test("replaces old plugin hooks on reinstall", () => {
    const existing: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User hook"),
        createHook(`Old plugin ${PLUGIN_MARKER}`),
      ]),
    ];
    const plugin: MatcherConfig[] = [
      createMatcher("Task", [createHook(`New plugin ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(existing, plugin);

    expect(result.length).toBe(1);
    expect(result[0]!.hooks.length).toBe(2);
    expect(result[0]!.hooks[0]!.description).toBe("User hook");
    expect(result[0]!.hooks[1]!.description).toContain("New plugin");
  });

  test("handles complex merge scenario", () => {
    const existing: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User task hook"),
        createHook(`Old plugin task ${PLUGIN_MARKER}`),
      ]),
      createMatcher("Bash", [createHook("User bash hook")]),
    ];
    const plugin: MatcherConfig[] = [
      createMatcher("Task", [createHook(`New task ${PLUGIN_MARKER}`)]),
      createMatcher("*", [createHook(`New global ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(existing, plugin);

    expect(result.length).toBe(3);

    const taskMatcher = result.find((m) => m.matcher === "Task");
    expect(taskMatcher).toBeDefined();
    expect(taskMatcher!.hooks.length).toBe(2);
    expect(taskMatcher!.hooks[0]!.description).toBe("User task hook");
    expect(taskMatcher!.hooks[1]!.description).toContain("New task");

    const bashMatcher = result.find((m) => m.matcher === "Bash");
    expect(bashMatcher).toBeDefined();
    expect(bashMatcher!.hooks.length).toBe(1);

    const globalMatcher = result.find((m) => m.matcher === "*");
    expect(globalMatcher).toBeDefined();
    expect(globalMatcher!.hooks.length).toBe(1);
  });

  test("preserves order of existing matchers", () => {
    const existing: MatcherConfig[] = [
      createMatcher("First", [createHook("First hook")]),
      createMatcher("Second", [createHook("Second hook")]),
    ];
    const plugin: MatcherConfig[] = [
      createMatcher("Third", [createHook(`Third ${PLUGIN_MARKER}`)]),
    ];

    const result = mergeHooks(existing, plugin);

    expect(result[0]!.matcher).toBe("First");
    expect(result[1]!.matcher).toBe("Second");
    expect(result[2]!.matcher).toBe("Third");
  });
});

describe("countPluginHooks", () => {
  test("returns 0 for undefined", () => {
    expect(countPluginHooks(undefined)).toBe(0);
  });

  test("returns 0 for empty array", () => {
    expect(countPluginHooks([])).toBe(0);
  });

  test("returns 0 for only user hooks", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [createHook("User hook 1"), createHook("User hook 2")]),
    ];
    expect(countPluginHooks(matchers)).toBe(0);
  });

  test("counts single plugin hook", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [createHook(`Plugin ${PLUGIN_MARKER}`)]),
    ];
    expect(countPluginHooks(matchers)).toBe(1);
  });

  test("counts multiple plugin hooks across matchers", () => {
    const matchers: MatcherConfig[] = [
      createMatcher("Task", [
        createHook("User hook"),
        createHook(`Plugin 1 ${PLUGIN_MARKER}`),
      ]),
      createMatcher("*", [
        createHook(`Plugin 2 ${PLUGIN_MARKER}`),
        createHook(`Plugin 3 ${PLUGIN_MARKER}`),
      ]),
    ];
    expect(countPluginHooks(matchers)).toBe(3);
  });

  test("returns 0 for non-array input", () => {
    // @ts-expect-error - testing runtime behavior
    expect(countPluginHooks("not an array")).toBe(0);
  });
});
