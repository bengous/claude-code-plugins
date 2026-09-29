import type { Branded, ParseResult } from "./paths.ts";

/** `MAJOR.MINOR.PATCH`, the shape of every `plugin.json` of the marketplace. */
export type PluginVersion = Branded<string, "PluginVersion">;

/** A full commit SHA: 40 lowercase hex characters. */
export type CommitSha = Branded<string, "CommitSha">;

/** The running plugin's version and the commit it was built from. */
export type VellumBuild = { readonly version: PluginVersion; readonly commit: CommitSha };

/** What the adapter read, each source as found or why not. */
export type BuildSources = {
  readonly pluginRoot: string;
  /** `version` of `.claude-plugin/plugin.json`. */
  readonly version: ParseResult<string>;
  /** `gitCommitSha` of Claude Code's install entry for this root. */
  readonly installed: ParseResult<string>;
  /** The stdout of `git rev-parse HEAD` in the plugin root; `null` when not read, the install entry having answered. */
  readonly head: ParseResult<string> | null;
};

const PLUGIN_VERSION = /^\d+\.\d+\.\d+$/u;

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export function parsePluginVersion(raw: string): ParseResult<PluginVersion> {
  // SAFETY: the brand is granted by the regex match on the line below.
  return PLUGIN_VERSION.test(raw)
    ? { ok: true, value: raw as PluginVersion }
    : { ok: false, error: `not a plugin version (MAJOR.MINOR.PATCH): ${raw}` };
}

export function parseCommitSha(raw: string): ParseResult<CommitSha> {
  // SAFETY: the brand is granted by the regex match on the line below.
  return COMMIT_SHA.test(raw)
    ? { ok: true, value: raw as CommitSha }
    : { ok: false, error: `not a commit SHA (40 lowercase hex): ${raw}` };
}

/** The install entry's commit, which wins over the head: the adapter reads the head only when this fails. */
export function installedCommit(installed: ParseResult<string>): ParseResult<CommitSha> {
  return installed.ok ? parseCommitSha(installed.value) : installed;
}

function headCommit(head: ParseResult<string> | null): ParseResult<CommitSha> {
  if (head === null) return { ok: false, error: "not read" };

  return head.ok ? parseCommitSha(head.value.trim()) : head;
}

function commitOf(sources: BuildSources): ParseResult<CommitSha> {
  const installed = installedCommit(sources.installed);

  if (installed.ok) return installed;
  const head = headCommit(sources.head);

  return head.ok
    ? head
    : {
        ok: false,
        error: `no commit for ${sources.pluginRoot}: installed_plugins.json: ${installed.error}; git rev-parse HEAD: ${head.error}`,
      };
}

export function vellumBuildOf(sources: BuildSources): ParseResult<VellumBuild> {
  const version = sources.version.ok ? parsePluginVersion(sources.version.value) : sources.version;

  if (!version.ok) return { ok: false, error: `plugin.json: ${version.error}` };
  const commit = commitOf(sources);

  return commit.ok ? { ok: true, value: { version: version.value, commit: commit.value } } : commit;
}
