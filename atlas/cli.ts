import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { toPlan } from "./adapter.ts";
import { checkMap, openReport } from "./check.ts";
import { MAP_FILE, THREADS_FILE, loadFolder, planOf } from "./folder.ts";
import { ReplyError, appendReply } from "./reply.ts";
import { WHO, openItems, readThreads } from "./threads.ts";

const ROOT = import.meta.dir;

const CLI = join(ROOT, "cli.ts");

const TYPES_SOURCE = join(ROOT, "atlas.ts");

const TEMPLATE = join(ROOT, "template");

const TYPES_FILE = "atlas.d.ts";

const TSCONFIG_FILE = "tsconfig.json";

const DRAFTS = "drafts";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const USAGE = `usage: bun ${CLI} <command> …
  new <dir>                                         scaffold an empty map folder
  sync <dir>                                        write the plugin's atlas.d.ts and tsconfig.json into it
  check <dir> [--open]                              validate the map, type-check, lint and format-check it,
                                                    compare atlas.d.ts with the plugin's; --open lists the open points
  reply <dir> <open id> --as agent|human "<text>"   add an entry to an open point's thread
  draft <dir> <name> [--adopt | --drop]             copy the map into <dir>/drafts/<name> and print its path;
                                                    --adopt makes the map the draft and deletes it, --drop deletes it`;

class CliError extends Error {}

type Parsed = { readonly positionals: readonly string[]; readonly flags: ReadonlySet<string> };

function parse(args: readonly string[], known: readonly string[]): Parsed {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const unknown = [...flags].find((f) => !known.includes(f));

  if (unknown !== undefined) {
    throw new CliError(`unknown flag ${unknown}\n${USAGE}`);
  }

  return { positionals: args.filter((a) => !a.startsWith("--")), flags };
}

function mapFolder(arg: string): string {
  const dir = resolve(arg);

  if (!existsSync(join(dir, MAP_FILE))) {
    throw new CliError(`${dir} holds no ${MAP_FILE}: not a map folder`);
  }

  return dir;
}

function one(positionals: readonly string[]): string {
  const [dir, ...extra] = positionals;

  if (dir === undefined || extra.length > 0) {
    throw new CliError(USAGE);
  }

  return dir;
}

function sync(dir: string): void {
  copyFileSync(TYPES_SOURCE, join(dir, TYPES_FILE));
  copyFileSync(join(TEMPLATE, TSCONFIG_FILE), join(dir, TSCONFIG_FILE));
}

function scaffold(arg: string): string {
  const dir = resolve(arg);

  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new CliError(`${dir} is not empty: new scaffolds a map folder in an empty one`);
  }

  cpSync(TEMPLATE, dir, { recursive: true });
  sync(dir);

  return dir;
}

type Step = { readonly name: string; readonly ok: boolean; readonly report: string };

async function planStep(dir: string): Promise<Step> {
  try {
    const { map, config } = await loadFolder(dir);
    const errors = checkMap(map, config, await Bun.file(join(dir, THREADS_FILE)).json());

    if (errors.length > 0) {
      return { name: "plan", ok: false, report: errors.join("\n") };
    }

    const plan = toPlan(map, config);

    return {
      name: "plan",
      ok: true,
      report: `${plan.zones.length} zones, ${plan.nodes.length} bricks, ${plan.edges.length} arrows`,
    };
  } catch (error: unknown) {
    return {
      name: "plan",
      ok: false,
      report: error instanceof Error ? error.message : String(error),
    };
  }
}

const bin = (pkg: string, path: string): string =>
  join(dirname(Bun.resolveSync(`${pkg}/package.json`, ROOT)), path);

function toolSteps(dir: string): Step[] {
  // Every source is named: a walk from the folder skips it whole when it sits under an ignored
  // directory, as a draft does under its map's .gitignore.
  const sources = [...new Bun.Glob("**/*.ts").scanSync({ cwd: dir })]
    .filter((file) => !file.startsWith(`${DRAFTS}/`))
    .toSorted();

  const tools = [
    [
      "tsgo",
      bin("@typescript/native-preview", "bin/tsgo"),
      "-p",
      TSCONFIG_FILE,
      "--pretty",
      "false",
    ],
    [
      "oxlint",
      bin("oxlint", "bin/oxlint"),
      "-c",
      join(ROOT, "lint", "oxlintrc.json"),
      "--disable-nested-config",
      "--format",
      "unix",
      ...sources,
    ],
    [
      "oxfmt",
      bin("oxfmt", "bin/oxfmt"),
      "-c",
      join(ROOT, "lint", "oxfmtrc.json"),
      "--check",
      ...sources,
      TSCONFIG_FILE,
    ],
  ] as const;

  return tools.map(([name, ...argv]) => {
    const tool = Bun.spawnSync([process.execPath, ...argv], { cwd: dir });
    const ok = tool.exitCode === 0;

    return {
      name,
      ok,
      report: ok ? "" : `${tool.stdout.toString()}${tool.stderr.toString()}`.trim(),
    };
  });
}

function typesStep(dir: string): Step {
  const file = join(dir, TYPES_FILE);
  const fix = `run bun ${CLI} sync ${dir}`;

  if (!existsSync(file)) {
    return { name: TYPES_FILE, ok: false, report: `${file} is missing: ${fix}` };
  }

  return readFileSync(file).equals(readFileSync(TYPES_SOURCE))
    ? { name: TYPES_FILE, ok: true, report: "" }
    : {
        name: TYPES_FILE,
        ok: false,
        report: `${file} differs from the plugin's atlas.ts, stale or edited by hand: ${fix}`,
      };
}

async function check(dir: string): Promise<number> {
  const steps = [await planStep(dir), ...toolSteps(dir), typesStep(dir)];

  for (const { name, ok, report } of steps) {
    if (ok) {
      console.log(report === "" ? `${name}: ok` : `${name}: ok, ${report}`);
    } else {
      console.log(`${name}: failed\n${report}`);
    }
  }

  const failed = steps.flatMap(({ name, ok }) => (ok ? [] : [name]));

  if (failed.length > 0) {
    console.error(`check: ${failed.join(", ")} failed`);

    return 1;
  }

  return 0;
}

async function listOpen(dir: string): Promise<number> {
  const plan = await planOf(dir);
  const { threads, errors } = readThreads(await Bun.file(join(dir, THREADS_FILE)).json());

  if (errors.length > 0) {
    throw new CliError(errors.join("\n"));
  }

  console.log(openReport(plan, threads));

  return 0;
}

async function reply(args: readonly string[]): Promise<number> {
  const at = args.indexOf("--as");
  const who = WHO.find((w) => w === args[at + 1]);
  const rest = at === -1 ? args : args.filter((_, i) => i !== at && i !== at + 1);
  const [dirArg, id, text, ...extra] = rest;

  if (
    at === -1 ||
    who === undefined ||
    dirArg === undefined ||
    id === undefined ||
    text === undefined ||
    extra.length > 0
  ) {
    throw new CliError(
      `${USAGE}\n(--as takes ${WHO.join(" or ")}; quote the text as one argument)`,
    );
  }

  const dir = mapFolder(dirArg);
  const known = new Set(openItems(await planOf(dir)).map((o) => o.id));
  const threads = await appendReply(join(dir, THREADS_FILE), known, id, who, text);

  console.log(
    `${id}: ${threads[id]?.length ?? 0} entries, waits for ${who === "agent" ? "human" : "agent"}`,
  );

  return 0;
}

const entries = (dir: string): string[] => readdirSync(dir).filter((name) => name !== DRAFTS);

function copyEntries(from: string, to: string): void {
  for (const name of entries(from)) {
    cpSync(join(from, name), join(to, name), { recursive: true });
  }
}

function draft(args: readonly string[]): number {
  const { positionals, flags } = parse(args, ["--adopt", "--drop"]);
  const [dirArg, name, ...extra] = positionals;

  if (dirArg === undefined || name === undefined || extra.length > 0 || flags.size > 1) {
    throw new CliError(USAGE);
  }

  if (!KEBAB.test(name)) {
    throw new CliError(`draft name ${name}: kebab-case, as split-storage`);
  }

  const dir = mapFolder(dirArg);
  const path = join(dir, DRAFTS, name);

  if (flags.size === 0) {
    if (existsSync(path)) {
      throw new CliError(`${path} exists: adopt it (--adopt) or drop it (--drop) first`);
    }

    mkdirSync(path, { recursive: true });
    copyEntries(dir, path);
    console.log(path);

    return 0;
  }

  if (!existsSync(join(path, MAP_FILE))) {
    throw new CliError(`no draft ${name}: ${path} holds no ${MAP_FILE}`);
  }

  if (flags.has("--adopt")) {
    for (const entry of entries(dir)) {
      rmSync(join(dir, entry), { recursive: true });
    }

    copyEntries(path, dir);
  }

  rmSync(path, { recursive: true });
  console.log(flags.has("--adopt") ? `adopted ${path} into ${dir}` : `dropped ${path}`);

  return 0;
}

const COMMANDS = ["new", "sync", "check", "reply", "draft"] as const;

type Command = (typeof COMMANDS)[number];

const isCommand = (word: string): word is Command => COMMANDS.some((c) => c === word);

async function run(command: Command, args: readonly string[]): Promise<number> {
  switch (command) {
    case "new": {
      console.log(scaffold(one(parse(args, []).positionals)));

      return 0;
    }

    case "sync": {
      const dir = mapFolder(one(parse(args, []).positionals));
      sync(dir);
      console.log(`${dir}: wrote ${TYPES_FILE} and ${TSCONFIG_FILE}`);

      return 0;
    }

    case "check": {
      const { positionals, flags } = parse(args, ["--open"]);
      const dir = mapFolder(one(positionals));

      return flags.has("--open") ? await listOpen(dir) : await check(dir);
    }

    case "reply": {
      return await reply(args);
    }

    case "draft": {
      return draft(args);
    }
  }
}

if (import.meta.main) {
  const [command = "", ...args] = process.argv.slice(2);

  if (!isCommand(command)) {
    console.error(USAGE);
    process.exit(1);
  }

  try {
    process.exitCode = await run(command, args);
  } catch (error: unknown) {
    if (!(error instanceof CliError || error instanceof ReplyError)) {
      throw error;
    }

    console.error(`${command}: ${error.message}`);
    process.exitCode = 1;
  }
}
