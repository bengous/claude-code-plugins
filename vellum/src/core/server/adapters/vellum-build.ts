import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ParseResult } from "../domain/paths.ts";
import { parseCommitSha, vellumBuildOf } from "../domain/vellum-build.ts";
import type { VellumBuild } from "../domain/vellum-build.ts";

/** The plugin's folder, the one holding `.claude-plugin/`: this file sits four levels under it. */
export const PLUGIN_ROOT = resolve(import.meta.dir, "../../../..");

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
async function installedCommit(root: string): Promise<ParseResult<string>> {
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

async function gitHead(root: string): Promise<ParseResult<string>> {
  try {
    const git = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(git.stdout).text(),
      new Response(git.stderr).text(),
      git.exited,
    ]);

    return exitCode === 0 ? { ok: true, value: stdout } : { ok: false, error: stderr.trim() };
  } catch (cause) {
    return { ok: false, error: reason(cause) };
  }
}

/** Never throws: what fails is the answer of `GET /api/vellum-build`, never the server's start. */
export async function readVellumBuild(pluginRoot: string): Promise<ParseResult<VellumBuild>> {
  const root = await realpath(pluginRoot).catch(() => pluginRoot);
  const manifest = await readText(join(root, ".claude-plugin", "plugin.json"));
  const version = manifest.ok ? manifestVersion(manifest.value) : manifest;
  const installed = await installedCommit(root);
  const settled = installed.ok && parseCommitSha(installed.value).ok;
  const head = settled ? installed : await gitHead(root);

  return vellumBuildOf({ pluginRoot: root, version, installed, head });
}
