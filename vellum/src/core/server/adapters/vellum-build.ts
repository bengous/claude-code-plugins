import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ParseResult } from "../domain/paths.ts";
import { installedCommit, vellumBuildOf } from "../domain/vellum-build.ts";
import type { VellumBuild } from "../domain/vellum-build.ts";

/** The plugin's folder, the one holding `.claude-plugin/`: this file sits four levels under it. */
export const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..");

const MANIFEST = ".claude-plugin/plugin.json";

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readText(path: string): Promise<ParseResult<string>> {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (cause) {
    return { ok: false, error: `${path}: ${reason(cause)}` };
  }
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- the block below IS the boundary parser the rules ask for: two JSON files arrive as text, one of them Claude Code's own and undocumented, and there is no earlier place to parse them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function manifestVersion(text: string): ParseResult<string> {
  const manifest = parseJson(text);
  const version = isRecord(manifest) ? manifest["version"] : undefined;

  return typeof version === "string"
    ? { ok: true, value: version }
    : { ok: false, error: "no version" };
}

/** Every `{ installPath, gitCommitSha }` of the file; a shape it does not have lists none. */
function installEntries(text: string): readonly { installPath: string; sha: string | null }[] {
  const installs = parseJson(text);
  const plugins = isRecord(installs) ? installs["plugins"] : undefined;
  const lists = isRecord(plugins) ? Object.values(plugins) : [];

  return lists
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .flatMap((entry) =>
      isRecord(entry) && typeof entry["installPath"] === "string"
        ? [
            {
              installPath: entry["installPath"],
              sha: typeof entry["gitCommitSha"] === "string" ? entry["gitCommitSha"] : null,
            },
          ]
        : [],
    );
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion */

/** The `gitCommitSha` Claude Code recorded for this root, both paths compared through their links. */
async function installedSha(root: string): Promise<ParseResult<string>> {
  const configDir = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
  const text = await readText(join(configDir, "plugins", "installed_plugins.json"));

  if (!text.ok) return text;

  for (const entry of installEntries(text.value)) {
    const path = await realpath(entry.installPath).catch(() => entry.installPath);

    if (path === root) {
      return entry.sha === null
        ? { ok: false, error: "the entry has no gitCommitSha" }
        : { ok: true, value: entry.sha };
    }
  }

  return { ok: false, error: "no entry" };
}

/** The server's environment but git's own variables: a `GIT_DIR` there would name its repository for any root. */
function gitEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).flatMap(([name, value]) =>
      name.startsWith("GIT_") || value === undefined ? [] : [[name, value]],
    ),
  );
}

async function git(root: string, ...args: readonly string[]): Promise<ParseResult<string>> {
  try {
    const run = Bun.spawn(["git", "-C", root, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);

    return exitCode === 0 ? { ok: true, value: stdout } : { ok: false, error: stderr.trim() };
  } catch (cause) {
    return { ok: false, error: reason(cause) };
  }
}

/**
 * HEAD of the repository that tracks this copy. `git -C` climbs to any repository around the
 * root, a dotfiles one holding `~/.claude` included: its HEAD is not this plugin's commit.
 */
async function gitHead(root: string): Promise<ParseResult<string>> {
  const tracked = await git(root, "ls-files", "--error-unmatch", MANIFEST);

  if (!tracked.ok) return { ok: false, error: `${MANIFEST} is not tracked: ${tracked.error}` };

  return await git(root, "rev-parse", "HEAD");
}

/** Never throws: what fails is the answer of `GET /api/vellum-build`, never the server's start. */
export async function readVellumBuild(pluginRoot: string): Promise<ParseResult<VellumBuild>> {
  const root = await realpath(pluginRoot).catch(() => pluginRoot);
  const manifest = await readText(join(root, MANIFEST));
  const version = manifest.ok ? manifestVersion(manifest.value) : manifest;
  const installed = await installedSha(root);
  const head = installedCommit(installed).ok ? null : await gitHead(root);

  return vellumBuildOf({ pluginRoot: root, version, installed, head });
}
