import { existsSync } from "node:fs";

import type { GitCommand } from "../guard/argv.ts";
import { gitCommandOf } from "../guard/argv.ts";
import { GIT } from "../guard/mentions.ts";
import { commandsOf, parseLine } from "../guard/shell.ts";
import type { AssessOptions } from "../guard/walk.ts";
import { texts, viewsOf } from "../guard/walk.ts";

/** A `git commit` a line runs as written: where it starts, where it runs, and the heredoc it reads. */
export type CommitInvocation = {
  /** The offset in the line where the command starts: what the line runs before it ends there. */
  readonly start: number;
  /** null once an earlier `cd` leaves the directory unknown. */
  readonly cwd: string | null;
  readonly lost: string | null;
  readonly git: GitCommand;
  /** For each of `git.args`, whether Bash expands part of it when the line runs (`$NAME`, `$(…)`, backticks). */
  readonly argsExpand: readonly boolean[];
  /** The body of the first heredoc the command reads, as written: `-F -` takes its message from it. */
  readonly heredoc: string | null;
  /** Whether Bash expands that body: its delimiter is unquoted and it holds a `$` or a backtick. */
  readonly heredocExpands: boolean;
};

const COMMIT = /(?<![\w.-])commit(?![\w.-])/u;

/**
 * Every `git commit` the line runs as written, in a subshell too. A commit inside `$(…)` or backticks, behind a
 * wrapper that hides its words (`xargs`, `env -S`), in a nested script (`bash -c`) or on a line that defines a
 * function is not one.
 */
export function commitsOf(
  script: string,
  cwd: string,
  options: AssessOptions = {},
): CommitInvocation[] {
  if (!GIT.test(script) || !COMMIT.test(script)) {
    return [];
  }

  const line = parseLine(script);

  if (line.definesFunction) {
    return [];
  }

  const views = viewsOf(line, script, cwd, { exists: options.exists ?? existsSync }, options);

  return commandsOf(line).flatMap((command) => {
    const view = views.get(command);

    if (command.substitution || view === undefined || view.unwrapped.opaque !== null) {
      return [];
    }

    const git = gitCommandOf(texts(view.unwrapped.argv));

    if (git?.subcommand !== "commit") {
      return [];
    }

    const [heredoc] = command.heredocs;
    const body = heredoc === undefined ? null : script.slice(heredoc.start, heredoc.end);

    return [
      {
        start: command.words[0]?.start ?? 0,
        cwd: view.cwd,
        lost: view.lost,
        git,
        argsExpand: view.unwrapped.argv.slice(git.index + 1).map((word) => word.expands),
        heredoc: body,
        heredocExpands: heredoc?.expands === true && /[$`]/u.test(body ?? ""),
      },
    ];
  });
}
