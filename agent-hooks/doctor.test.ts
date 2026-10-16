import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeWiring, codexWiring } from "./doctor.ts";

const PLUGIN = "agent-hooks@bengous-plugins";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-doctor-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(name: string, content: string): string {
  const target = path.join(dir, name);
  writeFileSync(target, content);

  return target;
}

type CommandHook = { readonly type: "command"; readonly command: string };

/** The part of a Claude Code settings file the wiring check reads. */
type Settings = {
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
  readonly hooks?: Readonly<Record<string, readonly { readonly hooks: readonly CommandHook[] }[]>>;
  readonly permissions?: { readonly allow: readonly string[] };
};

function settings(name: string, value: Settings): string {
  return file(name, JSON.stringify(value));
}

function hook(event: string, command: string): Settings {
  return { hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } };
}

function user(value: Settings): string {
  return settings("user.json", value);
}

const missing = (): string => path.join(dir, "missing.json");

describe("claudeWiring", () => {
  test("the plugin enabled in the user settings is the wiring", () => {
    const check = claudeWiring([user({ enabledPlugins: { [PLUGIN]: true } })]);

    expect(check.line).toBe(`ok      claude wiring: plugin ${PLUGIN}`);
  });

  test("the plugin enabled at project scope is the wiring", () => {
    const project = settings("project.json", { enabledPlugins: { [PLUGIN]: true } });

    expect(claudeWiring([user({}), project, missing()]).line).toBe(
      `ok      claude wiring: plugin ${PLUGIN}`,
    );
  });

  test("a higher scope that disables the plugin wins over the user settings", () => {
    const local = settings("local.json", { enabledPlugins: { [PLUGIN]: false } });

    expect(claudeWiring([user({ enabledPlugins: { [PLUGIN]: true } }), local]).line).toBe(
      "WARN    claude wiring: no agent-hooks Stop hook: enable the agent-hooks plugin",
    );
  });

  test("the plugin and a settings hook together warn that each hook runs twice", () => {
    const target = user({
      enabledPlugins: { [PLUGIN]: true },
      ...hook("Stop", "~/.local/bin/agent-hooks stop"),
    });

    expect(claudeWiring([target]).line).toStartWith(
      `WARN    claude wiring: plugin ${PLUGIN} and a hook in ${target} both run the kit`,
    );
  });

  test("a pre-edit hook in project settings beside the plugin counts as a second wiring", () => {
    const project = settings("project.json", hook("PreToolUse", "agent-hooks pre-edit"));

    expect(claudeWiring([user({ enabledPlugins: { [PLUGIN]: true } }), project]).line).toStartWith(
      `WARN    claude wiring: plugin ${PLUGIN} and a hook in ${project}`,
    );
  });

  test("a Stop and a SubagentStop hook in settings, without the plugin, are the wiring", () => {
    const target = user({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "~/.local/bin/agent-hooks stop" }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "~/.local/bin/agent-hooks stop" }] }],
      },
    });

    expect(claudeWiring([target]).line).toBe(`ok      claude wiring: ${target}`);
  });

  test("a settings wiring without SubagentStop warns that subagents go unchecked", () => {
    const target = user(hook("Stop", "~/.local/bin/agent-hooks stop"));

    expect(claudeWiring([target]).line).toBe(
      `WARN    claude wiring: ${target} wires the Stop but no SubagentStop, so subagents go unchecked: enable the agent-hooks plugin, which wires both`,
    );
  });

  // JSON escapes the quotes around the entry; the check reads the parsed command.
  test("a Stop hook calling the entry between escaped quotes is read as the kit's", () => {
    const target = file(
      "user.json",
      '{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "bun \\"/cache/agent-hooks/1.0.1/agent-hooks.ts\\" stop" }] }] } }',
    );

    expect(claudeWiring([target]).line).toStartWith(
      `WARN    claude wiring: ${target} wires the Stop but no SubagentStop`,
    );
  });

  test("a permission rule that names the hook is no hook", () => {
    const target = user({
      enabledPlugins: { [PLUGIN]: true },
      permissions: { allow: ["Bash(~/.local/bin/agent-hooks stop *)"] },
    });

    expect(claudeWiring([target]).line).toBe(`ok      claude wiring: plugin ${PLUGIN}`);
  });

  test("a hook whose name only starts with stop is no Stop hook of the kit", () => {
    const target = user(hook("Stop", "bun .claude/hooks/agent-hooks stop-gates"));

    expect(claudeWiring([target]).line).toStartWith(
      "WARN    claude wiring: no agent-hooks Stop hook",
    );
  });

  test("a disabled plugin is no wiring", () => {
    const target = user({ enabledPlugins: { [PLUGIN]: false } });

    expect(claudeWiring([target]).line).toStartWith(
      "WARN    claude wiring: no agent-hooks Stop hook",
    );
  });

  test("a plugin whose name only starts the same is no wiring", () => {
    const target = user({ enabledPlugins: { "agent-hooks-extra@other": true } });

    expect(claudeWiring([target]).line).toStartWith(
      "WARN    claude wiring: no agent-hooks Stop hook",
    );
  });

  test("missing settings files are no wiring, and no error", () => {
    expect(claudeWiring([missing()]).line).toStartWith(
      "WARN    claude wiring: no agent-hooks Stop hook",
    );
  });

  test("a settings file that does not parse warns, naming it", () => {
    const broken = file("broken.json", "{ not json");

    expect(claudeWiring([broken]).line).toBe(`WARN    claude wiring: ${broken} unreadable`);
  });

  test("every check is a WARN at worst, never a failure", () => {
    expect(claudeWiring([file("broken.json", "{")]).ok).toBe(true);
  });
});

describe("codexWiring", () => {
  test("the plugin entry called through bun in the user config is the wiring", () => {
    const config = file(
      "user.toml",
      `[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ncommand = 'bun "/cache/agent-hooks/1.0.1/agent-hooks.ts" stop --harness codex'\ntype = "command"\n`,
    );

    expect(codexWiring([path.join(dir, "missing.toml"), config]).line).toBe(
      `ok      codex wiring: ${config}`,
    );
  });

  test("the agent-hooks symlink in the system config is the wiring", () => {
    const config = file(
      "system.toml",
      '[[hooks.Stop]]\n\n[[hooks.Stop.hooks]]\ncommand = "/fixture/user/.local/bin/agent-hooks stop --harness codex"\n',
    );

    expect(codexWiring([config]).line).toBe(`ok      codex wiring: ${config}`);
  });

  test("a commented Stop hook is no wiring, and the warning names every file read", () => {
    const config = file(
      "system.toml",
      '# [[hooks.Stop.hooks]]\n# command = "agent-hooks stop --harness codex"\n[[hooks.SessionStart]]\n\n[[hooks.SessionStart.hooks]]\ncommand = "agent-hooks session-start --harness codex"\n',
    );

    const other = path.join(dir, "missing.toml");

    expect(codexWiring([config, other]).line).toBe(
      `WARN    codex wiring: no agent-hooks stop hook in ${config} or ${other}`,
    );
  });
});
