import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { THREADS_FILE } from "./folder.ts";
import { readThreads } from "./threads.ts";

const CLI = join(import.meta.dir, "cli.ts");

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const TEMPLATE = join(import.meta.dir, "template");

const TMP = mkdtempSync(join(tmpdir(), "atlas-cli-"));

afterAll(() => {
  rmSync(TMP, { recursive: true });
});

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(...args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, CLI, ...args]);

  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

let folders = 0;

function copyOf(source: string): string {
  folders += 1;
  const dir = join(TMP, `copy-${folders}`);
  cpSync(source, dir, { recursive: true });

  return dir;
}

const sampleCopy = (): string => copyOf(SAMPLE);

function fresh(): string {
  folders += 1;
  const dir = join(TMP, `new-${folders}`);
  expect(cli("new", dir)).toEqual({ code: 0, stdout: `${dir}\n`, stderr: "" });

  return dir;
}

async function edit(file: string, from: string, to: string): Promise<void> {
  const text = await Bun.file(file).text();
  expect(text).toContain(from);
  await Bun.write(file, text.replace(from, to));
}

async function lineOf(file: string, needle: string): Promise<number> {
  const lines = (await Bun.file(file).text()).split("\n");

  return lines.findIndex((line) => line.includes(needle)) + 1;
}

const listing = (dir: string): string[] => readdirSync(dir).toSorted();

const OK = ["tsgo: ok", "oxlint: ok", "oxfmt: ok", "atlas.d.ts: ok"].join("\n");

test("an unknown command prints the usage", () => {
  const run = cli("nope");

  expect(run.code).toBe(1);
  expect(run.stderr).toStartWith(`usage: bun ${CLI} <command>`);
});

describe("new", () => {
  test("scaffolds a map folder that check passes", async () => {
    const dir = fresh();

    expect(listing(dir)).toEqual([
      ".gitignore",
      "atlas.config.ts",
      "atlas.d.ts",
      "map.ts",
      "threads.json",
      "tsconfig.json",
    ]);
    expect(await Bun.file(join(dir, THREADS_FILE)).text()).toBe("{}\n");
    expect(await Bun.file(join(dir, ".gitignore")).text()).toBe("drafts/\n");

    expect(cli("check", dir)).toEqual({
      code: 0,
      stdout: `plan: ok, 2 zones, 1 bricks, 0 arrows\n${OK}\n`,
      stderr: "",
    });
  });

  test("refuses a folder that is not empty", () => {
    const dir = sampleCopy();
    const run = cli("new", dir);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${dir} is not empty`);
  });
});

describe("check", () => {
  test("passes on the sample and the template as committed", async () => {
    expect(cli("check", sampleCopy())).toEqual({
      code: 0,
      stdout: `plan: ok, 4 zones, 8 bricks, 10 arrows\n${OK}\n`,
      stderr: "",
    });
    expect(cli("check", copyOf(TEMPLATE)).code).toBe(0);
    expect(await Bun.file(join(SAMPLE, "tsconfig.json")).text()).toBe(
      await Bun.file(join(TEMPLATE, "tsconfig.json")).text(),
    );
  });

  test("reports a type error with its file and line", async () => {
    const dir = sampleCopy();
    const map = join(dir, "map.ts");
    await edit(map, 'label: "Clients"', "label: 42");
    const line = await lineOf(map, "label: 42");
    const run = cli("check", dir);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("tsgo: failed\n");
    expect(run.stdout).toContain(`map.ts(${line},`);
    expect(run.stdout).toContain("error TS2322");
    expect(run.stderr).toBe("check: tsgo failed\n");
  });

  test("reports a lint and a format violation", async () => {
    const dir = sampleCopy();
    await edit(join(dir, "map.ts"), "\nexport default", "\nconst unused = 1;\n\nexport default");
    await edit(join(dir, "atlas.config.ts"), "palette: {", "palette:   {");
    const run = cli("check", dir);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("oxlint: failed\nmap.ts:3:7:");
    expect(run.stdout).toContain("no-unused-vars");
    expect(run.stdout).toContain("oxfmt: failed\n");
    expect(run.stdout).toContain("atlas.config.ts");
    expect(run.stderr).toBe("check: oxlint, oxfmt failed\n");
  });

  test("reports a stale atlas.d.ts, and sync makes it current", async () => {
    const dir = sampleCopy();
    const types = join(dir, "atlas.d.ts");
    await Bun.write(types, `${await Bun.file(types).text()}\nexport type Extra = string;\n`);
    const stale = cli("check", dir);

    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain(
      `atlas.d.ts: failed\n${types} differs from the plugin's atlas.ts, stale or edited by hand: run bun ${CLI} sync ${dir}`,
    );
    expect(stale.stderr).toBe("check: atlas.d.ts failed\n");

    expect(cli("sync", dir)).toEqual({
      code: 0,
      stdout: `${dir}: wrote atlas.d.ts and tsconfig.json\n`,
      stderr: "",
    });
    expect(cli("check", dir).code).toBe(0);
  });

  test("--open lists the open points", () => {
    const run = cli("check", sampleCopy(), "--open");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("backup-restore-untested  brick backup  waits: human");
    expect(run.stdout).toContain("1 open points: 0 wait for agent, 1 wait for human");
  });

  test("refuses a folder without map.ts", () => {
    const run = cli("check", TMP);

    expect(run.code).toBe(1);
    expect(run.stderr).toBe(`check: ${TMP} holds no map.ts: not a map folder\n`);
  });
});

describe("fmt", () => {
  test("formats what check reports misformatted, and leaves the drafts as they are", async () => {
    const dir = sampleCopy();
    const config = join(dir, "atlas.config.ts");
    const formatted = await Bun.file(config).text();
    cli("draft", dir, "kept");
    const drafted = join(dir, "drafts", "kept", "atlas.config.ts");
    await edit(config, "palette: {", "palette:   {");
    await edit(drafted, "palette: {", "palette:   {");
    const misformatted = cli("check", dir);

    expect(misformatted.code).toBe(1);
    expect(misformatted.stdout).toContain("oxfmt: failed\n");
    expect(misformatted.stdout).toContain("\natlas.config.ts (");
    expect(misformatted.stdout).not.toContain("drafts/");
    expect(misformatted.stdout).toContain(`\nrun bun ${CLI} fmt ${dir}\n`);

    expect(cli("fmt", dir)).toEqual({ code: 0, stdout: `${dir}: formatted\n`, stderr: "" });
    expect(await Bun.file(config).text()).toBe(formatted);
    expect(await Bun.file(drafted).text()).toContain("palette:   {");
    expect(cli("check", dir).code).toBe(0);
  });

  test("names the file oxfmt cannot parse", async () => {
    const dir = sampleCopy();
    await edit(join(dir, "atlas.config.ts"), "palette: {", "palette: {{");
    const run = cli("fmt", dir);

    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith("fmt: ");
    expect(run.stderr).toContain("atlas.config.ts");
  });
});

describe("reply", () => {
  test("adds an entry to the thread in threads.json", async () => {
    const dir = sampleCopy();
    const file = join(dir, THREADS_FILE);
    const { threads } = readThreads(await Bun.file(file).json());
    const run = cli("reply", dir, "backup-restore-untested", "--as", "human", " Restore it once. ");

    expect(run).toEqual({
      code: 0,
      stdout: "backup-restore-untested: 2 entries, waits for agent\n",
      stderr: "",
    });
    expect(await Bun.file(file).json()).toEqual({
      "backup-restore-untested": [
        ...(threads["backup-restore-untested"] ?? []),
        { who: "human", text: "Restore it once." },
      ],
    });
  });

  test("refuses an unknown id", () => {
    const run = cli("reply", sampleCopy(), "no-such-point", "--as", "agent", "x");

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("reply: unknown open id no-such-point");
  });

  test("refuses a who outside the enumeration", () => {
    const run = cli("reply", sampleCopy(), "backup-restore-untested", "--as", "codex", "x");

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--as takes human or agent");
  });
});

describe("draft", () => {
  test("copies the map into drafts/<name>, a map folder its own check reads", async () => {
    const dir = fresh();
    const run = cli("draft", dir, "split");
    const path = join(dir, "drafts", "split");

    expect(run).toEqual({ code: 0, stdout: `${path}\n`, stderr: "" });
    expect(listing(path)).toEqual(listing(dir).filter((name) => name !== "drafts"));
    expect(cli("check", path).code).toBe(0);

    await edit(join(path, "map.ts"), 'label: "Part"', "label: 42");
    await edit(join(path, "map.ts"), "\nexport default", "\nconst unused = 1;\n\nexport default");
    await edit(join(path, "atlas.config.ts"), "palette: {", "palette:   {");

    expect(cli("check", dir).code).toBe(0);
    expect(cli("check", path).stderr).toBe("check: tsgo, oxlint, oxfmt failed\n");
  });

  test("--adopt makes the map the draft and deletes it", async () => {
    const dir = fresh();
    const path = join(dir, "drafts", "rename");
    cli("draft", dir, "rename");
    await edit(join(path, "map.ts"), 'label: "Part"', 'label: "Core"');
    await Bun.write(join(path, "notes.txt"), "kept\n");
    await Bun.write(join(dir, "gone.txt"), "removed\n");
    const draftMap = await Bun.file(join(path, "map.ts")).text();

    expect(cli("draft", dir, "rename", "--adopt")).toEqual({
      code: 0,
      stdout: `adopted ${path} into ${dir}\n`,
      stderr: "",
    });
    expect(existsSync(path)).toBe(false);
    expect(await Bun.file(join(dir, "map.ts")).text()).toBe(draftMap);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "gone.txt"))).toBe(false);
    expect(cli("check", dir).code).toBe(0);
  });

  test("--drop deletes it and leaves the map as it was", async () => {
    const dir = fresh();
    const path = join(dir, "drafts", "trial");
    const map = await Bun.file(join(dir, "map.ts")).text();
    cli("draft", dir, "trial");
    await edit(join(path, "map.ts"), 'label: "Part"', 'label: "Core"');

    expect(cli("draft", dir, "trial", "--drop")).toEqual({
      code: 0,
      stdout: `dropped ${path}\n`,
      stderr: "",
    });
    expect(existsSync(path)).toBe(false);
    expect(await Bun.file(join(dir, "map.ts")).text()).toBe(map);
  });

  test("refuses a name taken, a draft that does not exist, and a name not in kebab-case", () => {
    const dir = fresh();
    cli("draft", dir, "taken");

    expect(cli("draft", dir, "taken").stderr).toContain("exists: adopt it (--adopt) or drop it");
    expect(cli("draft", dir, "missing", "--adopt").stderr).toContain("no draft missing");
    expect(cli("draft", dir, "Not_Kebab").stderr).toContain("kebab-case");
  });
});
