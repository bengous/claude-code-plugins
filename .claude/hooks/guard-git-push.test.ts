import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HOOK_EXIT } from "./guard-destructive.ts";
import { decide, parsePush, type PushCommand } from "./guard-git-push.ts";

// -- parsePush ----------------------------------------------------------------

describe("parsePush ignores non-push commands", () => {
  const notPush = [
    "git status",
    "git fetch origin",
    "git pull --rebase",
    "bun test",
    'echo "git push origin dev:main"',
    "git commit -m 'git push origin main'",
  ];

  for (const cmd of notPush) {
    test(`not-push: ${cmd}`, () => {
      expect(parsePush(cmd).kind).toBe("not-push");
    });
  }
});

function targetsOf(cmd: string): ReadonlyArray<{ ref: string; forced: boolean }> {
  const parsed = parsePush(cmd);
  if (parsed.kind !== "push") throw new Error(`expected a push: ${cmd}`);
  return parsed.targets;
}

describe("parsePush extracts destinations", () => {
  test("bare branch argument", () => {
    expect(targetsOf("git push origin dev")).toEqual([{ ref: "dev", forced: false }]);
  });

  test("refspec destination", () => {
    expect(targetsOf("git push origin feature/x:dev")).toEqual([{ ref: "dev", forced: false }]);
  });

  test("sha refspec destination", () => {
    expect(targetsOf("git push origin 2f46dd6:main")).toEqual([{ ref: "main", forced: false }]);
  });

  test("fully qualified destination is normalized", () => {
    expect(targetsOf("git push origin HEAD:refs/heads/main")).toEqual([
      { ref: "main", forced: false },
    ]);
  });

  test("delete refspec still names its destination", () => {
    expect(targetsOf("git push origin :dev")).toEqual([{ ref: "dev", forced: false }]);
  });

  test("multiple refspecs", () => {
    expect(targetsOf("git push origin dev feature/x")).toEqual([
      { ref: "dev", forced: false },
      { ref: "feature/x", forced: false },
    ]);
  });

  test("remote alone yields no targets", () => {
    expect(targetsOf("git push origin")).toEqual([]);
  });

  test("bare push yields no targets", () => {
    expect(targetsOf("git push")).toEqual([]);
  });

  test("flags are not read as remote or refspec", () => {
    expect(targetsOf("git push -u origin feature/x")).toEqual([
      { ref: "feature/x", forced: false },
    ]);
  });

  test("value flags do not shift positionals", () => {
    expect(targetsOf("git push --push-option ci.skip origin dev")).toEqual([
      { ref: "dev", forced: false },
    ]);
  });

  test("push segment inside a compound command", () => {
    expect(
      targetsOf("git fetch origin && git rebase origin/dev && git push origin feature/x:dev"),
    ).toEqual([{ ref: "dev", forced: false }]);
  });

  test("collects targets across several push segments", () => {
    expect(targetsOf("git push origin dev; git push origin feature/x")).toEqual([
      { ref: "dev", forced: false },
      { ref: "feature/x", forced: false },
    ]);
  });
});

describe("parsePush detects force", () => {
  const forced = [
    "git push --force origin dev",
    "git push -f origin dev",
    "git push origin dev --force",
    "git push origin dev -f",
    "git push --force-with-lease origin dev",
    "git push --force-with-lease=dev origin dev",
    "git push --force-if-includes --force-with-lease origin dev",
  ];

  for (const cmd of forced) {
    test(`forced: ${cmd}`, () => {
      expect(targetsOf(cmd)).toEqual([{ ref: "dev", forced: true }]);
    });
  }

  test("plus refspec forces only its own target", () => {
    expect(targetsOf("git push origin +feature/x dev")).toEqual([
      { ref: "feature/x", forced: true },
      { ref: "dev", forced: false },
    ]);
  });

  test("force in one segment does not taint another", () => {
    expect(targetsOf("git push -f origin feature/x; git push origin dev")).toEqual([
      { ref: "feature/x", forced: true },
      { ref: "dev", forced: false },
    ]);
  });

  test("non-force flags are not force", () => {
    expect(targetsOf("git push -u --dry-run origin dev")).toEqual([{ ref: "dev", forced: false }]);
  });
});

// -- decide --------------------------------------------------------------------

function pushOf(cmd: string): PushCommand {
  return parsePush(cmd);
}

describe("decide denies pushes to main", () => {
  const denied = [
    "git push origin dev:main",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push --force origin main",
  ];

  for (const cmd of denied) {
    test(`denies: ${cmd}`, () => {
      const verdict = decide(pushOf(cmd), null);
      expect(verdict.kind).toBe("deny");
      if (verdict.kind === "deny") expect(verdict.reason).toContain("release");
    });
  }
});

describe("decide denies force pushes to dev", () => {
  const denied = [
    "git push --force origin dev",
    "git push origin dev --force",
    "git push --force-with-lease origin dev",
    "git push origin +dev",
    "git push -f origin HEAD:dev",
  ];

  for (const cmd of denied) {
    test(`denies: ${cmd}`, () => {
      const verdict = decide(pushOf(cmd), null);
      expect(verdict.kind).toBe("deny");
      if (verdict.kind === "deny") expect(verdict.reason).toContain("force");
    });
  }
});

describe("decide allows sanctioned pushes", () => {
  const allowed = [
    "git push origin dev",
    "git push origin feature/x:dev",
    "git push -u origin feature/new-hook",
    "git push --force-with-lease origin feature/x",
    "git push --force-with-lease origin fix/typo",
    "git push origin HEAD:feature/x",
  ];

  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(decide(pushOf(cmd), null).kind).toBe("allow");
    });
  }
});

describe("decide resolves bare pushes against the current branch", () => {
  test("bare force push while on dev is denied", () => {
    expect(decide(pushOf("git push --force-with-lease"), "dev").kind).toBe("deny");
  });

  test("bare push while on main is denied", () => {
    expect(decide(pushOf("git push"), "main").kind).toBe("deny");
  });

  test("bare force push on a feature branch is allowed", () => {
    expect(decide(pushOf("git push --force-with-lease"), "feature/x").kind).toBe("allow");
  });

  test("bare push with no resolvable branch is allowed", () => {
    expect(decide(pushOf("git push"), null).kind).toBe("allow");
  });
});

// -- integration: subprocess -----------------------------------------------------

describe("subprocess integration", () => {
  const hookPath = import.meta.dir + "/guard-git-push.ts";

  async function runHook(command: string, env?: Record<string, string>) {
    const input = JSON.stringify({ tool_input: { command } });
    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { exitCode, stderr };
  }

  test("blocks a release push", async () => {
    const { exitCode, stderr } = await runHook("git push origin dev:main");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
    expect(stderr).toContain("BLOCKED");
    expect(stderr).toContain("release");
  });

  test("blocks a lease push to dev", async () => {
    const { exitCode, stderr } = await runHook("git push --force-with-lease origin dev");
    expect(exitCode).toBe(HOOK_EXIT.BLOCK);
    expect(stderr).toContain("docs/repo-ops.md");
  });

  test("allows a landing push", async () => {
    const { exitCode } = await runHook("git push origin feature/x:dev");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("allows a lease push to a feature branch", async () => {
    const { exitCode } = await runHook("git push --force-with-lease origin feature/x");
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("MAIN_BYPASS=1 allows the release push", async () => {
    const { exitCode } = await runHook("git push origin dev:main", { MAIN_BYPASS: "1" });
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  test("exits 0 on invalid JSON input", async () => {
    const proc = Bun.spawn(["bun", hookPath], {
      stdin: new Blob(["not json"]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(HOOK_EXIT.ALLOW);
  });

  // -- another repo via leading cd: its conventions are not ours to police ----

  const tmpDir = `${import.meta.dir}/.tmp-test-repo-push`;

  beforeAll(() => {
    const init = Bun.spawnSync(
      [
        "bash",
        "-c",
        [
          `rm -rf "${tmpDir}"`,
          `mkdir -p "${tmpDir}"`,
          `cd "${tmpDir}"`,
          "git init -q",
          "git commit --allow-empty -m init -q",
        ].join(" && "),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (init.exitCode !== 0) {
      throw new Error(`Failed to create test repo: ${init.stderr.toString()}`);
    }
  });

  afterAll(() => {
    Bun.spawnSync(["rm", "-rf", tmpDir]);
  });

  test("allows a main push in another repo reached via cd", async () => {
    const projectDir = `${import.meta.dir}/../..`;
    const { exitCode } = await runHook(`cd ${tmpDir} && git push origin dev:main`, {
      CLAUDE_PROJECT_DIR: projectDir,
    });
    expect(exitCode).toBe(HOOK_EXIT.ALLOW);
  });
});
