import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { toPlan } from "./adapter.ts";
import { checkMap, openReport } from "./check.ts";
import {
  DRAFTS,
  DraftError,
  TSCONFIG_FILE,
  TYPES_FILE,
  adoptDraft,
  dataFilesOf,
  dropDraft,
  ignoreDrafts,
  makeDraft,
  messageOf,
} from "./drafts.ts";
import { MAP_FILE, THREADS_FILE, loadFolder, planOf } from "./folder.ts";
import type { Plan } from "./model.ts";
import { ReplyError, appendReply } from "./reply.ts";
import { WHO, openItems, readThreads } from "./threads.ts";

const ROOT = import.meta.dir;

const CLI = join(ROOT, "cli.ts");

const TYPES_SOURCE = join(ROOT, "atlas.ts");

const TEMPLATE = join(ROOT, "template");

const USAGE = `usage: bun ${CLI} <command> …
  new <dir>                                         scaffold an empty map folder
  sync <dir>                                        write the plugin's atlas.d.ts and tsconfig.json into it,
                                                    and drafts/ into its .gitignore
  check <dir> [--open]                              validate the map, type-check, lint and format-check it,
                                                    compare atlas.d.ts and tsconfig.json with the plugin's;
                                                    --open lists the open points
  fmt <dir>                                         format the files check format-checks, in place
  reply <dir> <open id> --as agent|human "<text>"   add an entry to an open point's thread
  draft <dir> <name> [--adopt | --drop]             copy the map into <dir>/${DRAFTS}/<name> and print its path;
                                                    --adopt copies its data files and threads.json back
                                                    and deletes it,
                                                    --drop deletes it`;

class CliError extends Error {}

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const hint = (command: string, dir: string): string =>
  `run bun ${quote(CLI)} ${command} ${quote(dir)}`;

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

  return realpathSync(dir);
}

function one(positionals: readonly string[]): string {
  const [dir, ...extra] = positionals;

  if (dir === undefined || extra.length > 0) {
    throw new CliError(USAGE);
  }

  return dir;
}

async function loading<T>(load: () => Promise<T>, then: string): Promise<T> {
  try {
    return await load();
  } catch (error: unknown) {
    throw new CliError(`the map does not load: ${messageOf(error)}${then}`);
  }
}

const loadPlan = async (dir: string, then: string): Promise<Plan> =>
  await loading(() => planOf(dir), then);

const whereFix = (dir: string): string => `; ${hint("check", dir)} to see where`;

// oxlint-disable-next-line anti-slop/no-unknown-returns -- threads.json as JSON.parse leaves it: readThreads, which checkMap also runs, is its parser.
async function readJson(file: string): Promise<unknown> {
  try {
    return await Bun.file(file).json();
  } catch (error: unknown) {
    throw new CliError(`${file}: ${messageOf(error)}`);
  }
}

function sync(dir: string): void {
  copyFileSync(TYPES_SOURCE, join(dir, TYPES_FILE));
  copyFileSync(join(TEMPLATE, TSCONFIG_FILE), join(dir, TSCONFIG_FILE));
  ignoreDrafts(dir);
}

function scaffold(arg: string): string {
  const dir = resolve(arg);
  const entry = lstatSync(dir, { throwIfNoEntry: false });

  if (entry !== undefined && (!entry.isDirectory() || readdirSync(dir).length > 0)) {
    throw new CliError(`${dir} is not an empty folder: new scaffolds a map folder in one`);
  }

  cpSync(TEMPLATE, dir, { recursive: true });
  sync(dir);

  return dir;
}

type Step = { readonly name: string; readonly ok: boolean; readonly report: string };

async function planStep(dir: string): Promise<Step> {
  try {
    const { map, config } = await loading(() => loadFolder(dir), "");
    const errors = checkMap(map, config, await readJson(join(dir, THREADS_FILE)));

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
    if (!(error instanceof CliError)) {
      throw error;
    }

    return { name: "plan", ok: false, report: error.message };
  }
}

const bin = (pkg: string, path: string): string =>
  join(dirname(Bun.resolveSync(`${pkg}/package.json`, ROOT)), path);

const oxfmt = (files: readonly string[], mode: "--check" | "--write"): string[] => [
  bin("oxfmt", "bin/oxfmt"),
  "-c",
  join(ROOT, "lint", "oxfmtrc.json"),
  mode,
  ...files,
];

type ToolRun = { readonly ok: boolean; readonly output: string };

function runTool(dir: string, argv: readonly string[]): ToolRun {
  const tool = Bun.spawnSync([process.execPath, ...argv], { cwd: dir });

  return {
    ok: tool.exitCode === 0,
    output: `${tool.stdout.toString()}${tool.stderr.toString()}`.trim(),
  };
}

type Tool = { readonly name: string; readonly argv: readonly string[]; readonly fix: string };

function toolSteps(dir: string): Step[] {
  // Every file is named: oxlint's and oxfmt's own walks skip a folder whole when it sits under an
  // ignored directory, as a draft does under its map's .gitignore.
  const files = dataFilesOf(dir);

  const tools: readonly Tool[] = [
    {
      name: "tsgo",
      argv: [
        bin("@typescript/native-preview", "bin/tsgo"),
        "-p",
        TSCONFIG_FILE,
        "--pretty",
        "false",
      ],
      fix: "",
    },
    {
      name: "oxlint",
      argv: [
        bin("oxlint", "bin/oxlint"),
        "-c",
        join(ROOT, "lint", "oxlintrc.json"),
        "--disable-nested-config",
        "--format",
        "unix",
        ...files,
      ],
      fix: "",
    },
    { name: "oxfmt", argv: oxfmt(files, "--check"), fix: `\n${hint("fmt", dir)}` },
  ];

  return tools.map(({ name, argv, fix }) => {
    const { ok, output } = runTool(dir, argv);

    return { name, ok, report: ok ? "" : `${output}${fix}` };
  });
}

function format(dir: string): void {
  const { ok, output } = runTool(dir, oxfmt(dataFilesOf(dir), "--write"));

  if (!ok) {
    throw new CliError(output);
  }
}

function generatedStep(dir: string, name: string, source: string): Step {
  const file = join(dir, name);
  const fix = hint("sync", dir);

  if (!existsSync(file)) {
    return { name, ok: false, report: `${file} is missing: ${fix}` };
  }

  return readFileSync(file).equals(readFileSync(source))
    ? { name, ok: true, report: "" }
    : { name, ok: false, report: `${file} differs from ${source}, stale or edited: ${fix}` };
}

async function check(dir: string): Promise<number> {
  const steps = [
    await planStep(dir),
    ...toolSteps(dir),
    generatedStep(dir, TYPES_FILE, TYPES_SOURCE),
    generatedStep(dir, TSCONFIG_FILE, join(TEMPLATE, TSCONFIG_FILE)),
  ];

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
  const plan = await loadPlan(dir, whereFix(dir));
  const { threads, errors } = readThreads(await readJson(join(dir, THREADS_FILE)));

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
  const file = join(dir, THREADS_FILE);
  const known = new Set(openItems(await loadPlan(dir, whereFix(dir))).map((o) => o.id));
  await readJson(file);
  const threads = await appendReply(file, known, id, who, text);

  console.log(
    `${id}: ${threads[id]?.length ?? 0} entries, waits for ${who === "agent" ? "human" : "agent"}`,
  );

  return 0;
}

function draft(args: readonly string[]): number {
  const { positionals, flags } = parse(args, ["--adopt", "--drop"]);
  const [dirArg, name, ...extra] = positionals;

  if (dirArg === undefined || name === undefined || extra.length > 0 || flags.size > 1) {
    throw new CliError(USAGE);
  }

  const dir = mapFolder(dirArg);

  if (flags.has("--adopt")) {
    const { path, warnings } = adoptDraft(dir, name);
    console.log([`adopted ${path} into ${dir}`, ...warnings].join("; "));
  } else if (flags.has("--drop")) {
    console.log(`dropped ${dropDraft(dir, name)}`);
  } else {
    console.log(makeDraft(dir, name));
  }

  return 0;
}

const COMMANDS = ["new", "sync", "check", "fmt", "reply", "draft"] as const;

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
      console.log(`${dir}: wrote ${TYPES_FILE} and ${TSCONFIG_FILE}; .gitignore lists ${DRAFTS}/`);

      return 0;
    }

    case "check": {
      const { positionals, flags } = parse(args, ["--open"]);
      const dir = mapFolder(one(positionals));

      return flags.has("--open") ? await listOpen(dir) : await check(dir);
    }

    case "fmt": {
      const dir = mapFolder(one(parse(args, []).positionals));
      format(dir);
      console.log(`${dir}: formatted`);

      return 0;
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
    if (
      !(error instanceof CliError || error instanceof DraftError || error instanceof ReplyError)
    ) {
      throw error;
    }

    console.error(`${command}: ${error.message}`);
    process.exitCode = 1;
  }
}
