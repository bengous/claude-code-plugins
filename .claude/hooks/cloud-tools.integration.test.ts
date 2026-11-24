import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "cloud-tools.sh");

const SETUP = ".github/factory/setup.sh";

const SETUP_TEXT = "#!/usr/bin/env bash\necho setup\n";

/** Every program the hook starts but `mise`, so a test chooses whether the session has one. */
const PROGRAMS = ["bash", "sha256sum", "cut", "cat", "tail", "mkdir", "ln"] as const;

/** Records each call with its directory, fails `install` on demand, and leaves one shim at `reshim`. */
const FAKE_MISE = `#!/usr/bin/env bash
printf '%s %s\\n' "$PWD" "$*" >>"$HOME/mise.calls"
case "$1" in
  install)
    if [[ -n \${FAKE_MISE_FAILS:-} ]]; then
      echo "bun@1.0.0: no lockfile URL for linux-x64"
      exit 1
    fi
    ;;
  reshim)
    mkdir -p "$HOME/.local/share/mise/shims"
    : >"$HOME/.local/share/mise/shims/bun"
    ;;
esac
`;

let root = "";

let home = "";

let project = "";

let bin = "";

function revisionOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function installMise(): void {
  writeFileSync(join(bin, "mise"), FAKE_MISE);
  chmodSync(join(bin, "mise"), 0o755);
}

function calls(): string {
  const path = join(home, "mise.calls");

  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function runHook(env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn([join(bin, "bash"), HOOK], {
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: bin, HOME: home, CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_REMOTE: "true", ...env },
  });

  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return { exitCode, stdout };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cloud-tools-hook-"));
  home = join(root, "home");
  project = join(root, "project");
  bin = join(root, "bin");

  mkdirSync(home);
  mkdirSync(bin);
  mkdirSync(join(project, ".github/factory"), { recursive: true });
  writeFileSync(join(project, SETUP), SETUP_TEXT);
  writeFileSync(join(home, ".cloud-env-setup.revision"), `${revisionOf(SETUP_TEXT)}\n`);

  for (const program of PROGRAMS) {
    const path = Bun.which(program);

    if (path === null) throw new Error(`${program} is not on PATH`);

    symlinkSync(path, join(bin, program));
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cloud-tools.sh", () => {
  test("starts nothing outside a cloud session", async () => {
    installMise();

    const { exitCode, stdout } = await runHook({ CLAUDE_CODE_REMOTE: undefined });

    expect({ exitCode, stdout, calls: calls() }).toEqual({ exitCode: 0, stdout: "", calls: "" });
  });

  test("installs the project's tools and links their shims, with nothing to say", async () => {
    installMise();

    const { exitCode, stdout } = await runHook();

    expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: "" });
    expect(calls()).toBe(`${project} install\n${project} reshim\n`);
    expect(existsSync(join(home, ".local/bin/bun"))).toBe(true);
  });

  test("names the setup script when the environment ran another one", async () => {
    installMise();
    writeFileSync(join(home, ".cloud-env-setup.revision"), "0000\n");

    const { exitCode, stdout } = await runHook();

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`did not run ${SETUP} as this clone holds it (ran: 0000)`);
    expect(calls()).toContain("install");
  });

  test("names the setup script when the environment ran none", async () => {
    installMise();
    rmSync(join(home, ".cloud-env-setup.revision"));

    const { stdout } = await runHook();

    expect(stdout).toContain("(ran: none)");
  });

  test("says so and lets the session start when the environment has no mise", async () => {
    const { exitCode, stdout } = await runHook();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("mise is not installed in this cloud environment");
  });

  test("hands a failed install to the session and links no shim", async () => {
    installMise();

    const { exitCode, stdout } = await runHook({ FAKE_MISE_FAILS: "1" });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("mise install failed");
    expect(stdout).toContain("no lockfile URL for linux-x64");
    expect(existsSync(join(home, ".local/bin/bun"))).toBe(false);
  });
});
