import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { commit, git } from "./git-fixture.ts";

const HOOK = join(import.meta.dir, "private-sync.ts");

const GITIGNORE = readFileSync(join(import.meta.dir, "../../.gitignore"), "utf8");

const RELOAD = { hookEventName: "SessionStart", reloadSkills: true };

let root = "";

let remote = "";

let project = "";

const privateDir = () => join(project, ".private");

const excludeFile = () => join(project, ".git", "info", "exclude");

function write(dir: string, file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

async function repository(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  await git(["init", "-q", "-b", "main"], dir);
  await git(["add", "-A"], dir);
  await commit(["-m", "initial commit"], dir);
}

const configure = (url = remote): void => write(project, ".private.env", `PRIVATE_REPO=${url}\n`);

const status = async (dir: string): Promise<string> =>
  (await git(["status", "--porcelain", "--untracked-files=all"], dir)).text();

const pointsTo = (link: string, target: string): void => {
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(realpathSync(link)).toBe(realpathSync(target));
};

async function runHook(cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd })]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      CLAUDE_PROJECT_DIR: project,
      ...env,
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

const cloneMessage = () => ({
  systemMessage: `private-sync: cloned the private repository into ${privateDir()}`,
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "private-sync-"));
  const seed = join(root, "seed");

  await repository(seed, {
    "plans/plan.md": "a private plan\n",
    "scratch/note.md": "a note\n",
    "skills/demo-skill/SKILL.md": "a private skill\n",
  });
  remote = join(root, "remote.git");
  await git(["clone", "-q", "--bare", seed, remote], root);
  project = join(root, "project");

  await repository(project, {
    ".gitignore": GITIGNORE,
    ".claude/skills/field-test/SKILL.md": "a public skill\n",
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("private-sync hook", () => {
  test("does nothing and says nothing without .private.env", async () => {
    const exclude = readFileSync(excludeFile(), "utf8");

    const { exitCode, stdout, stderr } = await runHook(project);

    expect([exitCode, stdout, stderr]).toEqual([0, "", ""]);
    expect(readdirSync(project).toSorted()).toEqual([".claude", ".git", ".gitignore"]);
    expect(readFileSync(excludeFile(), "utf8")).toBe(exclude);
  });

  test("clones the private repository, links plans, .scratch and its skills, and leaves git status clean", async () => {
    configure();

    const { exitCode, stdout } = await runHook(project);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ...cloneMessage(), hookSpecificOutput: RELOAD });
    pointsTo(join(project, "plans"), join(privateDir(), "plans"));
    pointsTo(join(project, ".scratch"), join(privateDir(), "scratch"));
    pointsTo(join(project, ".claude/skills/demo-skill"), join(privateDir(), "skills/demo-skill"));
    expect(readlinkSync(join(project, "plans"))).toBe(".private/plans");
    expect(readlinkSync(join(project, ".claude/skills/demo-skill"))).toBe(
      "../../.private/skills/demo-skill",
    );
    expect(readFileSync(excludeFile(), "utf8").split("\n")).toContain("/.claude/skills/demo-skill");
    expect(await status(project)).toBe("");
  });

  test("a second run changes nothing and says nothing", async () => {
    configure();
    await runHook(project);
    const exclude = readFileSync(excludeFile(), "utf8");

    const { exitCode, stdout } = await runHook(project);

    expect([exitCode, stdout]).toEqual([0, ""]);
    expect(readFileSync(excludeFile(), "utf8")).toBe(exclude);
  });

  test("keeps the links out of git status on a branch whose .gitignore predates them", async () => {
    write(project, ".gitignore", "plans/\n/.private/\n/.private.env\n");
    await git(["add", "-A"], project);
    await commit(["-m", "an older .gitignore"], project);
    configure();

    await runHook(project);

    pointsTo(join(project, ".scratch"), join(privateDir(), "scratch"));
    expect(await status(project)).toBe("");
  });

  test("links a linked worktree outside the main tree to the main checkout's clone", async () => {
    configure();
    await runHook(project);
    const linked = join(root, "linked");
    await git(["worktree", "add", "-q", "-b", "feature/x", linked], project);

    const { exitCode, stdout } = await runHook(linked);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ hookSpecificOutput: RELOAD });
    pointsTo(join(linked, "plans"), join(privateDir(), "plans"));
    pointsTo(join(linked, ".scratch"), join(privateDir(), "scratch"));
    pointsTo(join(linked, ".claude/skills/demo-skill"), join(privateDir(), "skills/demo-skill"));
    expect(existsSync(join(linked, ".private"))).toBe(false);
    expect(await status(linked)).toBe("");
  });

  test("leaves a real plans/ and a tracked skill of the same name as they are, without a word", async () => {
    write(project, ".claude/skills/demo-skill/SKILL.md", "a public skill\n");
    await git(["add", "-A"], project);
    await commit(["-m", "a public demo-skill"], project);
    write(project, "plans/mine.md", "a public plan\n");
    configure();

    const { exitCode, stdout } = await runHook(project);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(cloneMessage());
    expect(lstatSync(join(project, "plans")).isDirectory()).toBe(true);
    expect(readdirSync(join(project, "plans"))).toEqual(["mine.md"]);
    expect(readFileSync(join(project, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toBe(
      "a public skill\n",
    );
    pointsTo(join(project, ".scratch"), join(privateDir(), "scratch"));
    expect(await status(project)).toBe("");
  });

  test("links no skill where .claude/skills/ is no directory", async () => {
    await git(["rm", "-q", "-r", ".claude"], project);
    await commit(["-m", "no skills"], project);
    configure();

    const { exitCode, stdout } = await runHook(project);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(cloneMessage());
    expect(existsSync(join(project, ".claude"))).toBe(false);
    pointsTo(join(project, "plans"), join(privateDir(), "plans"));
  });

  test("appends to an info/exclude without a final newline, its lines intact", async () => {
    writeFileSync(excludeFile(), "# mine\n/local-thing");
    configure();

    await runHook(project);

    expect(readFileSync(excludeFile(), "utf8")).toBe(
      "# mine\n/local-thing\n/plans\n/.scratch\n/.claude/skills/demo-skill\n",
    );
  });

  test("writes only into the session's repository when GIT_DIR names another", async () => {
    const other = join(root, "other");
    await repository(other, { "README.md": "another repository\n" });
    const otherExclude = readFileSync(join(other, ".git/info/exclude"), "utf8");
    configure();

    const { exitCode } = await runHook(project, { GIT_DIR: join(other, ".git") });

    expect(exitCode).toBe(0);
    pointsTo(join(project, ".claude/skills/demo-skill"), join(privateDir(), "skills/demo-skill"));
    expect(readFileSync(excludeFile(), "utf8")).toContain("/.claude/skills/demo-skill\n");
    expect(readFileSync(join(other, ".git/info/exclude"), "utf8")).toBe(otherExclude);
    expect(readdirSync(other).toSorted()).toEqual([".git", "README.md"]);
  });

  test("names a failed clone on one stderr line, and leaves no clone, staging copy or link", async () => {
    configure(join(root, "missing.git"));

    const { exitCode, stdout, stderr } = await runHook(project);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toStartWith("private-sync: ");
    expect(stderr.trim().split("\n")).toHaveLength(1);
    expect(readdirSync(project).toSorted()).toEqual([
      ".claude",
      ".git",
      ".gitignore",
      ".private.env",
    ]);
  });

  test("fails on a .private.env that names no PRIVATE_REPO", async () => {
    write(project, ".private.env", "OTHER=1\n");

    const { exitCode, stderr } = await runHook(project);

    expect(exitCode).toBe(1);
    expect(stderr).toStartWith("private-sync: ");
    expect(existsSync(privateDir())).toBe(false);
  });
});
