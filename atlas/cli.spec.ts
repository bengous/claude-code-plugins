import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { THREADS_FILE } from "./folder.ts";
import { readThreads } from "./threads.ts";

const CLI = join(import.meta.dir, "cli.ts");

const TYPES_SOURCE = join(import.meta.dir, "atlas.ts");

const SAMPLE = join(import.meta.dir, "fixtures", "sample");

const TEMPLATE = join(import.meta.dir, "template");

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "atlas-cli-")));

afterAll(() => {
  rmSync(TMP, { recursive: true });
});

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(...args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, CLI, ...args]);

  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const hint = (command: string, dir: string): string => `run bun '${CLI}' ${command} '${dir}'`;

let folders = 0;

function copyOf(source: string, parent = TMP): string {
  folders += 1;
  const dir = join(parent, `copy ${folders}`);
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

const snapshot = (dir: string): ReadonlyMap<string, string> =>
  new Map(
    [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].flatMap((file) =>
      file.startsWith("drafts/") ? [] : [[file, readFileSync(join(dir, file), "utf8")] as const],
    ),
  );

const OK = ["tsgo: ok", "oxlint: ok", "oxfmt: ok", "atlas.d.ts: ok", "tsconfig.json: ok"].join(
  "\n",
);

const isOneLine = (text: string): boolean =>
  text.endsWith("\n") && !text.slice(0, -1).includes("\n");

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

  test("refuses a folder that is not empty, and a file, in one line", () => {
    const dir = sampleCopy();
    const file = join(dir, "map.ts");

    expect(cli("new", dir)).toEqual({
      code: 1,
      stdout: "",
      stderr: `new: ${dir} is not an empty folder: new scaffolds a map folder in one\n`,
    });
    expect(cli("new", file)).toEqual({
      code: 1,
      stdout: "",
      stderr: `new: ${file} is not an empty folder: new scaffolds a map folder in one\n`,
    });
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

  test("reports a stale atlas.d.ts, which oxlint and oxfmt leave alone, and sync makes it current", async () => {
    const dir = sampleCopy();
    const types = join(dir, "atlas.d.ts");
    await Bun.write(types, `${await Bun.file(types).text()}export type   Extra =   string\n`);
    const stale = cli("check", dir);

    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain(
      `atlas.d.ts: failed\n${types} differs from ${TYPES_SOURCE}, stale or edited: ${hint("sync", dir)}\n`,
    );
    expect(stale.stderr).toBe("check: atlas.d.ts failed\n");

    expect(cli("sync", dir)).toEqual({
      code: 0,
      stdout: `${dir}: wrote atlas.d.ts and tsconfig.json; .gitignore lists drafts/\n`,
      stderr: "",
    });
    expect(cli("check", dir).code).toBe(0);
  });

  test("reports a tsconfig.json that differs from the template, as one that hides a file from tsgo", async () => {
    const dir = sampleCopy();
    const tsconfig = join(dir, "tsconfig.json");
    await edit(tsconfig, '"exclude": ["drafts"]', '"exclude": ["drafts", "map.ts"]');
    await edit(join(dir, "map.ts"), 'label: "Clients"', "label: 42");
    const hidden = cli("check", dir);

    expect(hidden.code).toBe(1);
    expect(hidden.stdout).toContain("tsgo: ok\n");
    expect(hidden.stdout).toContain(
      `tsconfig.json: failed\n${tsconfig} differs from ${join(TEMPLATE, "tsconfig.json")}, stale or edited: ${hint("sync", dir)}\n`,
    );
    expect(hidden.stderr).toBe("check: tsconfig.json failed\n");

    cli("sync", dir);

    expect(cli("check", dir).stderr).toBe("check: tsgo failed\n");
  });

  test("an .editorconfig above the map folder changes nothing check or fmt does", () => {
    const parent = join(TMP, "editor");
    mkdirSync(parent);
    writeFileSync(
      join(parent, ".editorconfig"),
      "root = true\n\n[*]\nindent_style = tab\nindent_size = 4\ntab_width = 4\nmax_line_length = 40\nend_of_line = crlf\ninsert_final_newline = false\nquote_type = single\n",
    );
    const dir = copyOf(SAMPLE, parent);
    const before = snapshot(dir);

    expect(cli("check", dir).code).toBe(0);
    expect(cli("fmt", dir).code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
  });

  test("--open lists the open points", () => {
    const run = cli("check", sampleCopy(), "--open");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("backup-restore-untested  brick backup  waits: human");
    expect(run.stdout).toContain("1 open points: 0 wait for agent, 1 wait for human");
  });

  test("--open reports a map that does not load, and a missing threads.json, in one line", async () => {
    const broken = sampleCopy();
    await edit(join(broken, "map.ts"), "export default {", "export default { ;");
    const run = cli("check", broken, "--open");

    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith("check: the map does not load: ");
    expect(run.stderr).toContain(hint("check", broken));
    expect(isOneLine(run.stderr)).toBe(true);

    const bare = sampleCopy();
    rmSync(join(bare, THREADS_FILE));
    const missing = cli("check", bare, "--open");

    expect(missing.code).toBe(1);
    expect(missing.stderr).toStartWith(`check: ${join(bare, THREADS_FILE)}: `);
    expect(isOneLine(missing.stderr)).toBe(true);
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
    expect(misformatted.stdout).toContain(`\n${hint("fmt", dir)}\n`);

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

describe("sync", () => {
  test("adds drafts/ to the map's .gitignore once, as draft does", () => {
    const dir = sampleCopy();
    const ignore = join(dir, ".gitignore");
    rmSync(ignore);
    cli("sync", dir);

    expect(readFileSync(ignore, "utf8")).toBe("drafts/\n");

    cli("sync", dir);

    expect(readFileSync(ignore, "utf8")).toBe("drafts/\n");

    const other = sampleCopy();
    writeFileSync(join(other, ".gitignore"), "node_modules");
    cli("draft", other, "first");
    cli("draft", other, "second");

    expect(readFileSync(join(other, ".gitignore"), "utf8")).toBe("node_modules\ndrafts/\n");
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

  test("reports a map that does not load in one line", async () => {
    const dir = sampleCopy();
    await edit(join(dir, "map.ts"), "export default {", "export default { ;");
    const run = cli("reply", dir, "backup-restore-untested", "--as", "agent", "x");

    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith("reply: the map does not load: ");
    expect(isOneLine(run.stderr)).toBe(true);
  });
});

describe("draft", () => {
  test("copies the map's own files, never a dot entry nor another file", () => {
    const dir = fresh();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, ".git", "hook.ts"), "export const hook = 1;\n");
    writeFileSync(join(dir, "notes.txt"), "the map's notes\n");
    const run = cli("draft", dir, "split");
    const path = join(dir, "drafts", "split");

    expect(run).toEqual({ code: 0, stdout: `${path}\n`, stderr: "" });
    expect(listing(path)).toEqual([
      ".base",
      "atlas.config.ts",
      "atlas.d.ts",
      "map.ts",
      "threads.json",
      "tsconfig.json",
    ]);
    expect(cli("check", path).code).toBe(0);
  });

  test("a broken draft leaves the map's check green, and its own check reports it", async () => {
    const dir = fresh();
    const path = join(dir, "drafts", "broken");
    cli("draft", dir, "broken");
    await edit(join(path, "map.ts"), 'label: "Part"', "label: 42");
    await edit(join(path, "map.ts"), "\nexport default", "\nconst unused = 1;\n\nexport default");
    await edit(join(path, "atlas.config.ts"), "palette: {", "palette:   {");

    expect(cli("check", dir).code).toBe(0);
    expect(cli("check", path).stderr).toBe("check: tsgo, oxlint, oxfmt failed\n");
  });

  test("copies a link as a link", () => {
    const dir = fresh();
    symlinkSync("map.ts", join(dir, "alias.ts"));
    cli("draft", dir, "linked");
    const alias = join(dir, "drafts", "linked", "alias.ts");

    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(alias)).toBe("map.ts");
  });

  test("refuses a link that leaves the map folder or is absolute, making no draft", () => {
    const dir = fresh();
    writeFileSync(join(TMP, "shared.ts"), "export const shared = 1;\n");
    symlinkSync(`../shared.ts`, join(dir, "shared.ts"));
    const outward = cli("draft", dir, "out");

    expect(outward.code).toBe(1);
    expect(outward.stderr).toBe(
      "draft: shared.ts links to ../shared.ts, which a draft cannot carry: only a relative link to a file of the map folder is drafted: no draft made\n",
    );
    expect(existsSync(join(dir, "drafts", "out"))).toBe(false);

    rmSync(join(dir, "shared.ts"));
    symlinkSync(join(dir, "map.ts"), join(dir, "absolute.ts"));

    expect(cli("draft", dir, "abs").stderr).toStartWith(
      `draft: absolute.ts links to ${join(dir, "map.ts")}, which a draft cannot carry`,
    );
    expect(existsSync(join(dir, "drafts", "abs"))).toBe(false);
  });

  test("a failed copy leaves no draft behind", () => {
    const dir = fresh();
    chmodSync(join(dir, "tsconfig.json"), 0o000);
    const run = cli("draft", dir, "unread");
    chmodSync(join(dir, "tsconfig.json"), 0o644);

    expect(run.code).toBe(1);
    expect(run.stderr).toEndWith(": no draft made\n");
    expect(existsSync(join(dir, "drafts", "unread"))).toBe(false);
  });

  test("--adopt copies the draft's data files and threads.json back, and no other file", async () => {
    const dir = fresh();
    const path = join(dir, "drafts", "rename");
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, "notes.txt"), "the map's notes\n");
    writeFileSync(join(dir, "old.ts"), "export const old = 1;\n");
    cli("draft", dir, "rename");

    await edit(join(path, "map.ts"), 'label: "Part"', 'label: "Core"');
    writeFileSync(join(path, "extra.ts"), "export const extra = 1;\n");
    rmSync(join(path, "old.ts"));
    await edit(join(path, "tsconfig.json"), '"exclude": ["drafts"]', '"exclude": []');
    writeFileSync(join(path, "atlas.d.ts"), "export type Edited = string;\n");
    writeFileSync(join(path, THREADS_FILE), '{ "draft-only": [] }\n');

    const unchanged = ["tsconfig.json", "atlas.d.ts", ".gitignore", ".git/HEAD", "notes.txt"].map(
      (file) => readFileSync(join(dir, file), "utf8"),
    );

    const draftMap = readFileSync(join(path, "map.ts"), "utf8");

    expect(cli("draft", dir, "rename", "--adopt")).toEqual({
      code: 0,
      stdout: `adopted ${path} into ${dir}\n`,
      stderr: "",
    });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(dir, "map.ts"), "utf8")).toBe(draftMap);
    expect(existsSync(join(dir, "extra.ts"))).toBe(true);
    expect(existsSync(join(dir, "old.ts"))).toBe(false);
    expect(readFileSync(join(dir, THREADS_FILE), "utf8")).toBe('{ "draft-only": [] }\n');
    expect(
      ["tsconfig.json", "atlas.d.ts", ".gitignore", ".git/HEAD", "notes.txt"].map((file) =>
        readFileSync(join(dir, file), "utf8"),
      ),
    ).toEqual(unchanged);
    expect(listing(join(dir, "drafts"))).toEqual([]);
  });

  test("the draft cycle: an open point retired in a draft leaves the map green once adopted", () => {
    const dir = sampleCopy();
    const path = join(dir, "drafts", "settle");
    cli("draft", dir, "settle");
    const map = readFileSync(join(path, "map.ts"), "utf8");
    const settled = map.replace(/\n\s*open: \[\n[\s\S]*?\n\s*\],/u, "");

    expect(settled).not.toBe(map);

    writeFileSync(join(path, "map.ts"), settled);
    writeFileSync(join(path, THREADS_FILE), "{}\n");

    expect(cli("check", path).code).toBe(0);
    expect(cli("draft", dir, "settle", "--adopt").code).toBe(0);
    expect(cli("check", dir).code).toBe(0);
    expect(readFileSync(join(dir, THREADS_FILE), "utf8")).toBe("{}\n");
  });

  test("a thread written in the draft with reply comes back with it", async () => {
    const dir = sampleCopy();
    const path = join(dir, "drafts", "answer");
    cli("draft", dir, "answer");
    cli("reply", path, "backup-restore-untested", "--as", "agent", "Answered in the draft.");
    cli("draft", dir, "answer", "--adopt");
    const { threads } = readThreads(await Bun.file(join(dir, THREADS_FILE)).json());

    expect(threads["backup-restore-untested"]?.at(-1)).toEqual({
      who: "agent",
      text: "Answered in the draft.",
    });
  });

  test("--adopt refuses, changing nothing, when the map's data changed since the draft", async () => {
    const dir = fresh();
    const path = join(dir, "drafts", "late");
    cli("draft", dir, "late");
    await edit(join(dir, "map.ts"), 'label: "Part"', 'label: "Live"');
    await edit(join(path, "map.ts"), 'label: "Part"', 'label: "Draft"');
    const before = snapshot(dir);
    const run = cli("draft", dir, "late", "--adopt");

    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith("draft: the map changed since the draft was made (map.ts)");
    expect(snapshot(dir)).toEqual(before);
    expect(readFileSync(join(path, "map.ts"), "utf8")).toContain('label: "Draft"');
  });

  test("--adopt refuses, changing nothing, when the map's threads.json changed since the draft", () => {
    const dir = sampleCopy();
    cli("draft", dir, "quiet");
    cli("reply", dir, "backup-restore-untested", "--as", "human", "Answered in the map.");
    const before = snapshot(dir);
    const run = cli("draft", dir, "quiet", "--adopt");

    expect(run.code).toBe(1);
    expect(run.stderr).toStartWith(
      "draft: the map changed since the draft was made (threads.json)",
    );
    expect(snapshot(dir)).toEqual(before);
  });

  test("--adopt that cannot move a file of the map puts back what it moved", () => {
    const dir = fresh();
    const path = join(dir, "drafts", "stuck");
    mkdirSync(join(dir, "parts"));
    writeFileSync(join(dir, "parts", "a.ts"), "export const a = 1;\n");
    cli("draft", dir, "stuck");
    writeFileSync(join(path, "map.ts"), "export default {};\n");
    chmodSync(join(dir, "parts"), 0o555);
    const before = snapshot(dir);
    const run = cli("draft", dir, "stuck", "--adopt");
    chmodSync(join(dir, "parts"), 0o755);

    expect(run.code).toBe(1);
    expect(run.stderr).toEndWith(": nothing was changed\n");
    expect(snapshot(dir)).toEqual(before);
    expect(listing(join(dir, "drafts"))).toEqual(["stuck"]);
  });

  test("--adopt that fails removes the folders it made in the map", () => {
    const dir = fresh();
    const path = join(dir, "drafts", "grow");
    mkdirSync(join(dir, "zz"));
    writeFileSync(join(dir, "zz", "readme.txt"), "no data here\n");
    cli("draft", dir, "grow");
    mkdirSync(join(path, "aa"));
    writeFileSync(join(path, "aa", "x.ts"), "export const x = 1;\n");
    mkdirSync(join(path, "zz"));
    writeFileSync(join(path, "zz", "new.ts"), "export const late = 1;\n");
    chmodSync(join(dir, "zz"), 0o555);
    const before = snapshot(dir);
    const run = cli("draft", dir, "grow", "--adopt");
    chmodSync(join(dir, "zz"), 0o755);

    expect(run.code).toBe(1);
    expect(run.stderr).toEndWith(": nothing was changed\n");
    expect(existsSync(join(dir, "aa"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  test("--adopt that cannot remove the draft says so, and the map stays adopted", () => {
    const dir = fresh();
    const path = join(dir, "drafts", "sticky");
    cli("draft", dir, "sticky");
    mkdirSync(join(path, "parts"));
    writeFileSync(join(path, "parts", "b.ts"), "export const b = 1;\n");
    chmodSync(join(path, "parts"), 0o555);
    const run = cli("draft", dir, "sticky", "--adopt");
    chmodSync(join(path, "parts"), 0o755);

    expect(run.code).toBe(0);
    expect(run.stdout).toStartWith(
      `adopted ${path} into ${dir}; could not remove the draft: EACCES`,
    );
    expect(run.stderr).toBe("");
    expect(readFileSync(join(dir, "parts", "b.ts"), "utf8")).toBe("export const b = 1;\n");
  });

  test("--adopt with a draft file it cannot read changes nothing", () => {
    const dir = fresh();
    const path = join(dir, "drafts", "locked");
    cli("draft", dir, "locked");
    writeFileSync(join(path, "extra.ts"), "export const extra = 1;\n");
    chmodSync(join(path, "extra.ts"), 0o000);
    const before = snapshot(dir);
    const run = cli("draft", dir, "locked", "--adopt");
    chmodSync(join(path, "extra.ts"), 0o644);

    expect(run.code).toBe(1);
    expect(run.stderr).toEndWith(": nothing was changed\n");
    expect(snapshot(dir)).toEqual(before);
    expect(listing(join(dir, "drafts"))).toEqual(["locked"]);
  });

  test("--drop deletes it and leaves the map as it was", () => {
    const dir = fresh();
    const path = join(dir, "drafts", "trial");
    const before = snapshot(dir);
    cli("draft", dir, "trial");
    writeFileSync(join(path, "map.ts"), "export default {};\n");

    expect(cli("draft", dir, "trial", "--drop")).toEqual({
      code: 0,
      stdout: `dropped ${path}\n`,
      stderr: "",
    });
    expect(existsSync(path)).toBe(false);
    expect(snapshot(dir)).toEqual(before);
  });

  test("refuses a drafts folder or a draft that is a link, and deletes nothing outside", () => {
    const dir = fresh();
    const outside = join(TMP, "outside");
    mkdirSync(join(outside, "victim"), { recursive: true });
    writeFileSync(join(outside, "victim", "map.ts"), "export default {};\n");
    symlinkSync(outside, join(dir, "drafts"));

    expect(cli("draft", dir, "victim", "--drop").stderr).toBe(
      `draft: ${join(dir, "drafts")} is a link: a draft lives inside its map folder\n`,
    );
    expect(cli("draft", dir, "other").code).toBe(1);

    rmSync(join(dir, "drafts"));
    mkdirSync(join(dir, "drafts"));
    symlinkSync(join(outside, "victim"), join(dir, "drafts", "victim"));

    expect(cli("draft", dir, "victim", "--drop").stderr).toBe(
      `draft: ${join(dir, "drafts", "victim")} is a link: a draft lives inside its map folder\n`,
    );
    expect(cli("draft", dir, "victim", "--adopt").code).toBe(1);
    expect(existsSync(join(outside, "victim", "map.ts"))).toBe(true);
  });

  test("refuses a name taken, a draft that does not exist, and a name not in kebab-case", () => {
    const dir = fresh();
    cli("draft", dir, "taken");

    expect(cli("draft", dir, "taken").stderr).toContain("exists: adopt it (--adopt) or drop it");
    expect(cli("draft", dir, "missing", "--adopt").stderr).toContain("no draft missing");
    expect(cli("draft", dir, "Not_Kebab").stderr).toContain("kebab-case");
  });
});
