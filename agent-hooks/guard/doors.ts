import { existsSync } from "node:fs";
import path from "node:path";

import type { GitCommand } from "./argv.ts";
import {
  CURRENT_BRANCH,
  PUSH_DESTINATION,
  ghCommandOf,
  gitCommandOf,
  isPrMerge,
  isReleaseCreate,
  isRunner,
  packageScriptOf,
  pushOf,
  releaseScriptOf,
} from "./argv.ts";
import { gatedDoorOf } from "./gated.ts";
import { apiDoor } from "./gh-api.ts";
import type { Assessment, Door, Mention, Unresolved, Vocabulary } from "./mentions.ts";
import {
  FILE_RUNNERS,
  GIT_RUNS_COMMANDS,
  INERT_ARGUMENTS,
  INLINE_CODE,
  INTERPRETERS,
  PACKAGE_EXECUTORS,
  RUNS_ARGUMENTS,
  SHELLS,
  findMentions,
  startsProcesses,
} from "./mentions.ts";
import type { Command, Line, Unwrapped, Word } from "./shell.ts";
import { parseLine } from "./shell.ts";
import type { AssessOptions, Classification, View, World } from "./walk.ts";
import {
  INERT,
  blocker,
  contains,
  programOf,
  quote,
  stdinRunner,
  texts,
  unresolved,
  viewsOf,
} from "./walk.ts";

/** The words of a gh invocation that decide its door: `--repo`'s value, and its positionals unless `repoOnly`. */
function ghDecisive(argv: readonly Word[], repoOnly: boolean): Word[] {
  const decisive: Word[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const word = argv[index];
    const text = word?.text ?? "";
    const [name = "", attached] = text.split(/=(.*)/su);

    if (word === undefined) {
      continue;
    }

    if (name === "-R" || name === "--repo") {
      const value = attached === undefined ? argv[index + 1] : word;
      index += attached === undefined ? 1 : 0;

      if (value !== undefined) {
        decisive.push(value);
      }
    } else if (text.startsWith("-R") && text.length > 2) {
      decisive.push(word);
    } else if (attached === undefined && GH_VALUE_OPTIONS.has(name)) {
      index += 1;
    } else if (!text.startsWith("-") && !repoOnly) {
      decisive.push(word);
    }
  }

  return decisive;
}

const GH_VALUE_OPTIONS = new Set([
  "-b",
  "--body",
  "-F",
  "--body-file",
  "-t",
  "--subject",
  "--match-head-commit",
  "-A",
  "--author-email",
  "-n",
  "--notes",
  "--notes-file",
  "--title",
  "--target",
  "--discussion-category",
  "--notes-start-tag",
]);

/** The door `command` opens, resolved or not; null when it opens none. */
function doorOf(view: View, vocabulary: Vocabulary, world: World): Classification | null {
  const { unwrapped } = view;
  const argv = texts(unwrapped.argv);
  const cwd = view.cwd ?? unwrapped.cwd;
  const git = gitCommandOf(argv);

  if (git !== null) {
    if (vocabulary.gitAliases.has(git.subcommand) || git.inlineAliases.includes(git.subcommand)) {
      return unresolved("push", `it runs through the git alias ${git.subcommand}`);
    }

    const push = git.subcommand === "push" ? pushOf(git.args) : null;

    if (push === null) {
      return null;
    }

    const moves = git.configs.find((key) => /^(?:remote|push|branch|url)\./u.test(key));

    if (moves !== undefined) {
      return unresolved("push", `git -c ${moves} changes where it pushes`);
    }

    const missing = locationsOf(git, cwd).find((dir) => !world.exists(dir));

    const absolute = isAbsoluteLocation(git.location);

    const why =
      missing === undefined
        ? blocker(
            view,
            {
              directory: !absolute,
              branch: push.targets.some(
                (target) => target.ref === CURRENT_BRANCH || target.ref === PUSH_DESTINATION,
              ),
            },
            unwrapped.argv.filter((word) => !word.text.startsWith("-")),
          )
        : `git -C ${quote(missing)}: no such directory yet`;

    return why === null
      ? { kind: "door", door: { kind: "push", git, cwd } }
      : unresolved("push", why);
  }

  const gh = ghCommandOf(argv);

  if (gh !== null && isPrMerge(gh)) {
    const why = blocker(
      view,
      { directory: gh.repo === null, branch: gh.positionals.length === 0 },
      ghDecisive(unwrapped.argv, false),
    );

    return why === null
      ? { kind: "door", door: { kind: "merge", gh, cwd } }
      : unresolved("merge", why);
  }

  if (gh?.group === "api") {
    return apiDoor(view, cwd, vocabulary.approvals);
  }

  const gated = vocabulary.approvals && gh !== null ? gatedDoorOf(view, gh, cwd) : null;

  if (gated !== null) {
    return gated;
  }

  if (gh !== null && isReleaseCreate(gh) && gh.repo === null && view.cwd === null) {
    return unresolved(
      "release",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (gh !== null && isReleaseCreate(gh) && vocabulary.profiledAt(cwd)) {
    const why = blocker(
      view,
      { directory: gh.repo === null, branch: false },
      ghDecisive(unwrapped.argv, true),
    );

    return why === null
      ? { kind: "door", door: { kind: "release-create", gh, cwd } }
      : unresolved("release", why);
  }

  const release = releaseScriptOf(argv, cwd);

  if (
    release !== null &&
    !release.dryRun &&
    view.cwd === null &&
    !path.isAbsolute(release.script)
  ) {
    return unresolved(
      "release",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (release !== null && vocabulary.profiledAt(path.dirname(release.path))) {
    if (release.dryRun) {
      return null;
    }

    const why = blocker(
      view,
      { directory: !path.isAbsolute(release.script), branch: false },
      unwrapped.argv.filter((word) => word.text === release.script),
    );

    return why === null
      ? { kind: "door", door: { kind: "release-script", release } }
      : unresolved("release", why);
  }

  const script = packageScriptOf(argv, cwd);

  if (script !== null && view.cwd === null && vocabulary.doorScriptNames.has(script.name)) {
    return unresolved(
      "script",
      `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
    );
  }

  if (script !== null && vocabulary.doorScriptsAt(script.cwd).has(script.name)) {
    const named = unwrapped.argv.findIndex((word) => word.text === script.name);

    const why = blocker(
      view,
      { directory: true, branch: false },
      unwrapped.argv.slice(0, named + 1),
    );

    return why === null
      ? { kind: "door", door: { kind: "script", script } }
      : unresolved("script", why);
  }

  return null;
}

function locationsOf(git: GitCommand, cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;

  for (let index = 0; index < git.location.length; index += 2) {
    const value = git.location[index + 1] ?? "";

    if (git.location[index] === "-C") {
      dir = path.resolve(dir, value);
      dirs.push(dir);
    }
  }

  return dirs;
}

/** What a mention that stands in an argument of a command opening no door is: data, or a command run another way. */
function argumentRole(
  mention: Mention,
  word: Word,
  view: View,
  vocabulary: Vocabulary,
): Classification {
  const role = roleOf(mention, word, view);

  // A release command is a door only where the repository has a landing profile; an unknown directory may have one.
  return role.kind === "unresolved" &&
    mention.kind === "release" &&
    view.cwd !== null &&
    !vocabulary.profiledAt(view.cwd)
    ? INERT
    : role;
}

function roleOf(mention: Mention, word: Word, view: View): Classification {
  const { unwrapped } = view;
  const program = programOf(unwrapped) ?? "";
  const argv = texts(unwrapped.argv);
  const quoted = word.quoted.some((span) => contains(span, mention.start));
  const git = gitCommandOf(argv);
  const gh = ghCommandOf(argv);

  if (git !== null) {
    const index = unwrapped.argv.indexOf(word);

    if (index > 0 && index < git.index && !quoted) {
      return unresolved(mention.kind, "it stands in a git -c option, which can define an alias");
    }

    if (GIT_RUNS_COMMANDS.has(git.subcommand)) {
      return unresolved(mention.kind, `it runs through git ${git.subcommand}`);
    }

    return git.subcommand === "config" && git.args.some((arg) => arg.startsWith("alias."))
      ? unresolved(mention.kind, "it defines a git alias")
      : INERT;
  }

  if (gh !== null) {
    return gh.group === "alias" ? unresolved(mention.kind, "it defines a gh alias") : INERT;
  }

  if (SHELLS.has(program) || RUNS_ARGUMENTS.has(program)) {
    return unresolved(mention.kind, `it runs through ${program}`);
  }

  if (INTERPRETERS.has(program) && argv.some((arg) => INLINE_CODE.has(arg))) {
    return startsProcesses(program, word.text)
      ? unresolved(mention.kind, `it runs as ${program} code that starts processes`)
      : INERT;
  }

  if (program === "find" && argv.some((arg) => arg.startsWith("-exec") || arg.startsWith("-ok"))) {
    return unresolved(mention.kind, "it runs through find -exec");
  }

  const tool = packageTool(argv);

  if (tool !== null) {
    return FILE_RUNNERS.has(path.basename(tool.name))
      ? unresolved(mention.kind, `it runs through ${tool.via} ${tool.name}`)
      : INERT;
  }

  if (quoted || INERT_ARGUMENTS.has(program) || isRunner(program)) {
    return INERT;
  }

  return mention.kind === "script"
    ? INERT
    : unresolved(mention.kind, `it runs through ${program}, which the guard does not read`);
}

/** The tool a package executor starts: `npx tsx`, `bunx tsx`, `bun x tsx`, `pnpm dlx tsx`, `npm exec tsx`. */
function packageTool(
  argv: readonly string[],
): { readonly via: string; readonly name: string } | null {
  const [program = "", first, ...rest] = argv.filter((arg) => !arg.startsWith("-"));
  const name = path.basename(program);

  if (PACKAGE_EXECUTORS.has(name)) {
    return first === undefined ? null : { via: name, name: first };
  }

  const via = `${name} ${first ?? ""}`;
  const tool = rest[0];

  return ["bun x", "pnpm dlx", "pnpm exec", "yarn dlx", "yarn exec", "npm exec"].includes(via) &&
    tool !== undefined
    ? { via, name: tool }
    : null;
}

/** A literal script of `bash -c '…'`: the word right after a `-c` flag, with nothing expanded in it. */
function isLiteralShellScript(unwrapped: Unwrapped, word: Word): boolean {
  const program = programOf(unwrapped) ?? "";
  const index = unwrapped.argv.indexOf(word);
  const flag = unwrapped.argv[index - 1]?.text ?? "";

  return SHELLS.has(program) && /^-\w*c\w*$/u.test(flag) && !word.expands;
}

function classify(
  mention: Mention,
  script: string,
  line: Line,
  views: ReadonlyMap<Command, View>,
  vocabulary: Vocabulary,
  world: World,
): Classification {
  for (const [command, view] of views) {
    const body = command.heredocs.find((span) => contains(span, mention.start));

    if (body !== undefined) {
      const runner = stdinRunner(view.unwrapped);
      const code = script.slice(body.start, body.end);

      if (body.expands && /\$\(|`/u.test(code)) {
        return unresolved(mention.kind, "its heredoc runs $(…) or backticks as the shell reads it");
      }

      if (runner === null || (INTERPRETERS.has(runner) && !startsProcesses(runner, code))) {
        return INERT;
      }

      return unresolved(mention.kind, `its heredoc feeds ${runner}`);
    }
  }

  let found: { readonly command: Command; readonly word: Word } | null = null;

  for (const command of views.keys()) {
    for (const word of command.words) {
      const narrower = found === null || word.end - word.start < found.word.end - found.word.start;

      if (contains(word, mention.start) && narrower) {
        found = { command, word };
      }
    }
  }

  if (found === null) {
    return line.inert.some((span) => contains(span, mention.start))
      ? INERT
      : unresolved(mention.kind, "the guard cannot place it in a command");
  }

  const view = views.get(found.command);

  if (view === undefined) {
    return unresolved(mention.kind, "the guard cannot place it in a command");
  }

  if (view.executedBy !== null) {
    return unresolved(mention.kind, `it is piped into ${view.executedBy}`);
  }

  if (view.unwrapped.runsNothing) {
    return INERT;
  }

  if (view.unwrapped.opaque !== null) {
    return unresolved(mention.kind, `${view.unwrapped.opaque} hides its words until it runs`);
  }

  const start = found.word.start;

  const word =
    [...view.unwrapped.argv, ...view.unwrapped.assignments].find(
      (candidate) => candidate.start === start,
    ) ?? found.word;

  const door = doorOf(view, vocabulary, world);

  if (door !== null) {
    return door;
  }

  if (isLiteralShellScript(view.unwrapped, word)) {
    return { kind: "nested", script: word, view };
  }

  if (!view.unwrapped.argv.includes(word)) {
    return word.quoted.some((span) => contains(span, mention.start)) &&
      view.unwrapped.opaque === null
      ? INERT
      : unresolved(
          mention.kind,
          `it stands in the options of ${view.unwrapped.wrappers.join(" ")}`,
        );
  }

  return argumentRole(mention, word, view, vocabulary);
}

/**
 * Accounts for every door the raw text of `script` mentions: inert text, a door invocation the guard can judge, or
 * a mention it cannot resolve. No mention, no parsing.
 */
export function assess(
  script: string,
  cwd: string,
  vocabulary: Vocabulary,
  options: AssessOptions = {},
): Assessment {
  const mentions = findMentions(script, vocabulary);

  if (mentions.length === 0) {
    return { doors: [], unresolved: [] };
  }

  const line = parseLine(script);

  if (line.definesFunction) {
    return {
      doors: [],
      unresolved: mentions.map((mention) => ({
        kind: mention.kind,
        why: "the line defines a shell function, which runs what the guard cannot follow",
      })),
    };
  }

  const world: World = { exists: options.exists ?? existsSync };
  const views = viewsOf(line, script, cwd, world, options);
  const doors: Door[] = [];
  const found: Unresolved[] = [];
  const nested = new Set<Word>();

  for (const mention of mentions) {
    const classification = classify(mention, script, line, views, vocabulary, world);

    if (classification.kind === "door") {
      doors.push(classification.door);
    } else if (classification.kind === "unresolved") {
      found.push(classification.unresolved);
    } else if (classification.kind === "nested" && !nested.has(classification.script)) {
      nested.add(classification.script);
      const { view } = classification;

      if (view.cwd === null) {
        found.push({
          kind: mention.kind,
          why: `an earlier ${quote(view.lost ?? "cd")} leaves its directory unknown`,
        });
      } else {
        const inner = assess(classification.script.text, view.cwd, vocabulary, {
          exists: world.exists,
          branch: view.branch,
          config: view.config,
        });

        doors.push(...inner.doors);
        found.push(...inner.unresolved);
      }
    }
  }

  return { doors: uniqueDoors(doors), unresolved: found };
}

/** Whether a git invocation names where it acts by absolute paths alone: `-C`, `--git-dir`, `--work-tree`. */
export function isAbsoluteLocation(location: readonly string[]): boolean {
  return (
    location.length > 0 &&
    location.every((value, index) => index % 2 === 0 || path.isAbsolute(value))
  );
}

/** One door per invocation: a command mentioned twice (`git push origin push`) is judged once. */
function uniqueDoors(doors: readonly Door[]): Door[] {
  const seen = new Set<string>();

  return doors.filter((door) => {
    const key = JSON.stringify(door);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}
