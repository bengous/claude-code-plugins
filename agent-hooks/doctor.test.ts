import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeWiring, codexWiring } from "./doctor.ts";

const PLUGIN_STOP = 'bun "/cache/agent-hooks/1.0.1/agent-hooks.ts" stop';

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

/** The part of `~/.claude/settings.json` the wiring check reads. */
type Settings = {
  readonly enabledPlugins?: Readonly<Record<string, boolean>>;
  readonly hooks?: Readonly<Record<string, readonly { readonly hooks: readonly CommandHook[] }[]>>;
  readonly statusLine?: CommandHook;
};

function settings(value: Settings): string {
  return file("settings.json", JSON.stringify(value));
}

function stopHook(command: string): Settings {
  return { hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } };
}

describe("claudeWiring", () => {
  test("the enabled plugin is the wiring", () => {
    const check = claudeWiring(
      settings({ enabledPlugins: { "agent-hooks@bengous-plugins": true } }),
    );

    expect(check.line).toBe("ok      claude wiring: plugin agent-hooks@bengous-plugins");
  });

  test("the plugin and a settings hook together warn that each hook runs twice", () => {
    const target = settings({
      enabledPlugins: { "agent-hooks@bengous-plugins": true },
      ...stopHook("~/.local/bin/agent-hooks stop"),
    });

    expect(claudeWiring(target).line).toStartWith(
      "WARN    claude wiring: plugin agent-hooks@bengous-plugins and a hook in",
    );
  });

  test("a pre-edit hook in settings beside the plugin counts as a second wiring", () => {
    const target = settings({
      enabledPlugins: { "agent-hooks@bengous-plugins": true },
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "~/.local/bin/agent-hooks pre-edit" }] },
        ],
      },
    });

    expect(claudeWiring(target).line).toStartWith("WARN");
  });

  test("a Stop hook in settings, without the plugin, is the wiring", () => {
    const target = settings(stopHook("~/.local/bin/agent-hooks stop"));

    expect(claudeWiring(target).line).toBe(`ok      claude wiring: ${target}`);
  });

  test("a disabled plugin is no wiring", () => {
    const target = settings({ enabledPlugins: { "agent-hooks@bengous-plugins": false } });

    expect(claudeWiring(target).line).toBe(
      "WARN    claude wiring: no agent-hooks Stop hook: enable the agent-hooks plugin",
    );
  });

  test("a plugin whose name only starts the same is no wiring", () => {
    const target = settings({ enabledPlugins: { "agent-hooks-extra@other": true } });

    expect(claudeWiring(target).line).toStartWith(
      "WARN    claude wiring: no agent-hooks Stop hook",
    );
  });

  test("the plugin's status message in settings is no hook", () => {
    const target = settings({
      enabledPlugins: { "agent-hooks@bengous-plugins": true },
      statusLine: { type: "command", command: "echo agent-hooks: lanes on the session scope" },
    });

    expect(claudeWiring(target).line).toBe(
      "ok      claude wiring: plugin agent-hooks@bengous-plugins",
    );
  });

  test("an unreadable settings file warns", () => {
    const missing = path.join(dir, "missing.json");

    expect(claudeWiring(missing).line).toBe(`WARN    claude wiring: ${missing} unreadable`);
  });

  test("every check is a WARN at worst, never a failure", () => {
    expect(claudeWiring(path.join(dir, "missing.json")).ok).toBe(true);
  });
});

describe("codexWiring", () => {
  test("the plugin entry called through bun in the user config is the wiring", () => {
    const user = file("user.toml", `[[hooks.Stop]]\ncommand = '${PLUGIN_STOP} --harness codex'\n`);

    expect(codexWiring([path.join(dir, "missing.toml"), user]).line).toBe(
      `ok      codex wiring: ${user}`,
    );
  });

  test("the agent-hooks symlink in the system config is the wiring", () => {
    const system = file(
      "system.toml",
      'command = "/fixture/user/.local/bin/agent-hooks stop --harness codex"\n',
    );

    expect(codexWiring([system]).line).toBe(`ok      codex wiring: ${system}`);
  });

  test("no Stop hook in any config warns, naming every file read", () => {
    const system = file("system.toml", 'command = "agent-hooks session-start --harness codex"\n');
    const user = path.join(dir, "missing.toml");

    expect(codexWiring([system, user]).line).toBe(
      `WARN    codex wiring: no agent-hooks stop hook in ${system} or ${user}`,
    );
  });
});
