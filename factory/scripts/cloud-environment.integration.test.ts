import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../lib/platform/process.ts";
import { SETUP_SCRIPT } from "./environment.ts";
import { REPO_PREFIX, TEMPLATES_DIR } from "./templates.ts";

const HOOK = join(TEMPLATES_DIR, REPO_PREFIX, ".claude/hooks/cloud-tools.sh");

const SETUP_TEMPLATE = readFileSync(join(TEMPLATES_DIR, REPO_PREFIX, SETUP_SCRIPT), "utf8");

const TOOLS = ".github/factory";

/** Every program the hook starts but `mise`, so a test chooses whether the session has one. */
const HOOK_PROGRAMS = ["bash", "sha256sum", "cut", "cat", "tail", "mkdir", "ln"] as const;

/** The programs the setup script starts beside the four each test stubs. */
const SETUP_PROGRAMS = ["mktemp", "rm", "tee"] as const;

/** Records each call with its directory, fails `install` on demand, and answers `bin-paths` with the directory `installMise` fills. */
const FAKE_MISE = `printf '%s %s\\n' "$PWD" "$*" >>"$HOME/mise.calls"
case "$1" in
  install)
    if [[ -n \${FAKE_MISE_FAILS:-} ]]; then
      echo "bun@1.0.0: no lockfile URL for linux-x64"
      exit 1
    fi
    ;;
  bin-paths)
    echo "$HOME/installs/bun/bin"
    ;;
esac`;

let root = "";

let home = "";

let project = "";

let bin = "";

/** A script as claude.ai runs it: its copy drops the file's final newline. */
const asClaudeAiHoldsIt = (text: string): string => text.replace(/\n+$/u, "");

/** The digest the setup script records of itself on claude.ai. */
function revisionOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(asClaudeAiHoldsIt(text)).digest("hex");
}

/** Puts each program of this machine in the test's `bin`, the only directory on a script's `PATH`. */
function linkPrograms(programs: readonly string[]): void {
  for (const program of programs) {
    const path = Bun.which(program);

    if (path === null) throw new Error(`${program} is not on PATH`);

    symlinkSync(path, join(bin, program));
  }
}

/** Puts a bash script of the test's own in its `bin`, in place of the program of that name. */
function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A `mise` on the PATH, and the directory it names: one tool, and one file that is no program. */
function installMise(): void {
  const tools = join(home, "installs/bun/bin");

  stub("mise", FAKE_MISE);
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "bun"), "#!/bin/sh\n");
  chmodSync(join(tools, "bun"), 0o755);
  writeFileSync(join(tools, "LICENSE"), "");
}

function declareTools(): void {
  writeFileSync(join(project, TOOLS, "mise.toml"), '[tools]\nbun = "latest"\n');
}

function fileOf(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Runs a script with the test's `bin` as its whole `PATH` and the test's `home` as its HOME. */
async function runScript(script: string, env: Readonly<Record<string, string | undefined>>) {
  const result = await run([join(bin, "bash"), script], { env: { PATH: bin, HOME: home, ...env } });

  if (result.kind !== "exited")
    throw new Error(`the script did not exit: ${JSON.stringify(result)}`);

  return { exitCode: result.code, stdout: result.stdout };
}

function runHook(env: Readonly<Record<string, string | undefined>> = {}) {
  return runScript(HOOK, { CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_REMOTE: "true", ...env });
}

/**
 * Runs a setup script as claude.ai does, from a copy without the file's final newline, with no network: `apt-get`
 * records its call and answers as the test says, `curl` writes a file that is not the release, and `tar` and
 * `install` do what their arguments ask, so a script that skipped the checksum would leave a `mise` behind.
 */
async function runSetup(text: string, env: Readonly<Record<string, string>> = {}) {
  const copy = join(root, "setup-as-claude-ai-runs-it.sh");

  writeFileSync(copy, asClaudeAiHoldsIt(text));
  linkPrograms(SETUP_PROGRAMS);
  stub("apt-get", 'printf \'%s\\n\' "$*" >>"$HOME/apt.calls"\nexit "${STUB_APT_EXIT:-0}"');
  stub(
    "curl",
    'while (($#)); do [[ $1 == --output ]] && out=$2; shift; done\nprintf "not the release" >"$out"',
  );
  stub("tar", 'mkdir -p "$4/mise/bin" && : >"$4/mise/bin/mise"');
  stub("install", ': >"$4"');

  const { exitCode } = await runScript(copy, env);

  return { exitCode, log: fileOf(join(home, ".cloud-env-setup.log")) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "factory-cloud-"));
  home = join(root, "home");
  project = join(root, "project");
  bin = join(root, "bin");

  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(project, TOOLS), { recursive: true });
  writeFileSync(join(project, SETUP_SCRIPT), SETUP_TEMPLATE);
  writeFileSync(join(home, ".cloud-env-setup.revision"), `${revisionOf(SETUP_TEMPLATE)}\n`);
  linkPrograms(HOOK_PROGRAMS);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cloud-tools.sh", () => {
  test("starts nothing outside a cloud session", async () => {
    installMise();
    declareTools();

    expect(await runHook({ CLAUDE_CODE_REMOTE: undefined })).toEqual({ exitCode: 0, stdout: "" });
    expect(fileOf(join(home, "mise.calls"))).toBe("");
  });

  test("installs the declared tools, locked, from their directory, and links their programs", async () => {
    installMise();
    declareTools();

    expect(await runHook()).toEqual({ exitCode: 0, stdout: "" });
    expect(fileOf(join(home, "mise.calls"))).toBe(
      `${join(project, TOOLS)} install --locked\n${join(project, TOOLS)} bin-paths\n`,
    );
    expect(realpathSync(join(home, ".local/bin/bun"))).toBe(
      realpathSync(join(home, "installs/bun/bin/bun")),
    );
    expect(existsSync(join(home, ".local/bin/LICENSE"))).toBe(false);
  });

  test("is the hook this repository runs, unchanged: an edit of either file runs one of the two tests", () => {
    expect(readFileSync(HOOK, "utf8")).toBe(
      readFileSync(join(TEMPLATES_DIR, "../../.claude/hooks/cloud-tools.sh"), "utf8"),
    );
  });

  test("installs nothing in a repository that declares no tools", async () => {
    installMise();

    expect(await runHook()).toEqual({ exitCode: 0, stdout: "" });
    expect(fileOf(join(home, "mise.calls"))).toBe("");
  });

  test("names the setup script when the environment ran another one, or none", async () => {
    writeFileSync(join(home, ".cloud-env-setup.revision"), "0000\n");

    expect((await runHook()).stdout).toContain(
      `did not run ${SETUP_SCRIPT} as this clone holds it (ran: 0000)`,
    );

    rmSync(join(home, ".cloud-env-setup.revision"));

    expect((await runHook()).stdout).toContain("(ran: none)");
  });

  test("says so and lets the session start when the environment has no mise", async () => {
    declareTools();

    const { exitCode, stdout } = await runHook();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("mise is not installed in this cloud environment");
  });

  test("hands a failed install to the session and links no tool", async () => {
    installMise();
    declareTools();

    const { exitCode, stdout } = await runHook({ FAKE_MISE_FAILS: "1" });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("mise install failed");
    expect(stdout).toContain("no lockfile URL for linux-x64");
    expect(existsSync(join(home, ".local/bin/bun"))).toBe(false);
  });
});

describe("setup.sh", () => {
  test("records the digest cloud-tools.sh takes of the clone's file, which then has nothing to say", async () => {
    const { exitCode } = await runSetup(SETUP_TEMPLATE);

    expect(exitCode).toBe(0);
    expect(fileOf(join(home, ".cloud-env-setup.revision"))).toBe(`${revisionOf(SETUP_TEMPLATE)}\n`);
    expect(await runHook()).toEqual({ exitCode: 0, stdout: "" });
  });

  test("writes mise's settings and asks apt for nothing while it names no package", async () => {
    await runSetup(SETUP_TEMPLATE);

    expect(fileOf(join(home, ".config/mise/config.toml"))).toBe(
      '[settings]\nyes = true\ntrusted_config_paths = ["/"]\n',
    );
    expect(fileOf(join(home, "apt.calls"))).toBe("");
  });

  test("installs the packages it names, and lets the sessions start when one does not install", async () => {
    const named = SETUP_TEMPLATE.replace(
      "readonly PACKAGES=()",
      "readonly PACKAGES=(jq shellcheck)",
    );

    const { exitCode, log } = await runSetup(named, { STUB_APT_EXIT: "1" });

    expect(exitCode).toBe(0);
    expect(fileOf(join(home, "apt.calls"))).toStartWith("update --quiet\n");
    expect(log).toContain("FAILED  apt-get install jq shellcheck");
  });

  test("installs no mise from a download whose checksum differs, and lets the sessions start", async () => {
    const { exitCode, log } = await runSetup(SETUP_TEMPLATE);

    expect(exitCode).toBe(0);
    expect(log).toContain("FAILED  mise");
    expect(existsSync(join(home, ".local/bin/mise"))).toBe(false);
  });
});
