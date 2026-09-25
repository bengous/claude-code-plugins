import type { HookFailure, ResultOf } from "claude-code";

import type { ShellCall, Workdir } from "./parse.ts";

/**
 * `allow` runs the call whatever the session's mode, `check` hands it to the session's own
 * permission flow, `deny` refuses it with the reason the model reads.
 */
export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "check" }
  | { readonly kind: "deny"; readonly reason: string };

/** Where `\` separates names, as `/` does, or is a character of one. */
export type Platform = "posix" | "windows";

/**
 * Where the call's file and the project land, as `placed` answers them: `file` is `null` when
 * nothing can tell.
 */
export type Landed = {
  readonly file: string | null;
  readonly project: string;
  readonly platform: Platform;
};

/** `realPath` answers the platform's own separator, and `placed` joins a missing tail with `/`. */
const SEPARATORS = { posix: /\/+/gu, windows: /[\\/]+/gu } as const;

/** One spelling to compare: `/` alone between segments and none at the end, so `/` is `""`. */
function spelled(path: string, platform: Platform): string {
  const joined = path.replaceAll(SEPARATORS[platform], "/");

  return joined.endsWith("/") ? joined.slice(0, -1) : joined;
}

function holds(root: string, file: string): boolean {
  return file.startsWith(`${root}/`);
}

/**
 * While vellum plans, the files a call may write are the working directory's, and it writes
 * them outright, since the directory is vellum's own and the page shows every file in it.
 * A file outside the project is no change to the codebase, so the session's own flow decides
 * it: the scratchpad passes there without a prompt, and a write to a home or system file still
 * asks. Every other tool goes to that flow too, so reads are
 * untouched.
 *
 * The verdict compares where the paths land, so a symbolic link, a `..` or a platform's other
 * spelling of a file is already that file. The working directory is the project's own: where
 * the project lands, then `workdir` as written, so a link on the way to it, or the directory
 * itself a link, leads out of it and allows nothing. `realPath` keeps a case alias as written:
 * the allow compares as written and the deny folds the case, so on a volume that folds it
 * (NTFS, APFS) another case never takes a project file to the session's flow. Where the case
 * counts, the cost is a deny on `/work/PROJ` beside a project at `/work/proj`. A file that
 * lands nowhere known is denied, since the tool may still open it.
 */
export function lockVerdict(path: string, workdir: Workdir, landed: Landed): Verdict {
  if (landed.file === null) {
    return {
      kind: "deny",
      reason: `vellum is planning and cannot tell where ${path} lands; name the file by its full path`,
    };
  }

  const file = spelled(landed.file, landed.platform);
  const project = spelled(landed.project, landed.platform);

  if (holds(spelled(`${project}/${workdir}`, landed.platform), file)) return { kind: "allow" };

  return holds(project.toLowerCase(), file.toLowerCase())
    ? {
        kind: "deny",
        reason: `vellum is planning: files outside ${workdir} change after the plan is approved`,
      }
    : { kind: "check" };
}

/**
 * The lock's answer when its own hook failed. A `tool.check` hook that throws or overruns is
 * skipped and what is beneath runs in its place, which opens the lock; this closes it, whether
 * the failure landed before or after `next(e)`.
 */
export function lockFailed(kind: HookFailure["kind"]): ResultOf["tool.check"] {
  return { decision: "deny", reason: `the lock failed (${kind}); retry the call` };
}

/**
 * The tools that run a shell command. The engine offers `PowerShell` beside `Bash`, by default
 * on Windows, and its docs tell a hook that inspects shell commands to match `Bash|PowerShell`;
 * `Monitor` runs its command through the shell, under Bash's rules.
 */
export const SHELLS: ReadonlySet<string> = new Set(["Bash", "PowerShell", "Monitor"]);

/**
 * A move into a directory and its target, quoted or not, a character escaped by `\` kept: `cd`,
 * `pushd`, `chdir`, and PowerShell's `Set-Location`, `Push-Location` and `sl`, where a command
 * starts, each after the flags it takes.
 */
const MOVE =
  /(?:^|[;&|(\n])\s*(?:cd|pushd|chdir|set-location|push-location|sl)\s+(?:-\S+\s+)*("[^"]*"|'[^']*'|(?:\\.|[^\s;&|)])+)/gu;

/**
 * A command that puts a process in the background itself: a lone `&` (not `&&`, `2>&1`, `&>` or
 * `|&`), or `nohup`, `setsid`, `Start-Process` or `Start-Job` where a command starts.
 */
const DETACHED = /(?<![&>|])&(?![&>])|(?:^|[;&|(\n])\s*(?:nohup|setsid|start-process|start-job)\b/u;

/**
 * A shell call that enters the working directory, or names it from the background, is denied
 * while vellum plans: on Windows a process standing in a folder holds it, and the approval
 * cannot rename it. A command that ends gives the folder back, since the session returns to the
 * project's root after each one; one in the background holds it for as long as it runs. Only
 * the folder's name as written is read: a path the shell computes (`cd "$D"`) passes, and the
 * return to the root covers it.
 */
export function shellVerdict(call: ShellCall, workdir: Workdir): Verdict {
  const command = call.command.toLowerCase();
  const segment = workdir.split("/").findLast((part) => part !== "") ?? workdir;
  const folder = segment.toLowerCase();

  if (call.background || DETACHED.test(command)) {
    return command.includes(folder)
      ? {
          kind: "deny",
          reason: `vellum is planning: a background command that uses ${workdir} keeps the folder busy and blocks the approval on Windows; run it in the foreground`,
        }
      : { kind: "check" };
  }

  return [...command.matchAll(MOVE)].some(([, target]) => target?.includes(folder) === true)
    ? {
        kind: "deny",
        reason: `vellum is planning: stay at the project root and name files from there; a cd into ${workdir} keeps the folder busy and blocks the approval on Windows`,
      }
    : { kind: "check" };
}

/**
 * A settings allow rule (`Bash(mkdir:*)`, `PowerShell(Set-Content:*)`) would let a
 * file-modifying shell command past the lock, as the native plan mode never does: the lock
 * answers `ask` instead, which the engine puts to the mode's decider, a prompt in the manual
 * mode. An allow with no rule is the mode's own and stands: the built-in read-only set (`git
 * log`, `ls`), and in `acceptEdits` the filesystem commands that mode approves (`mkdir`, `mv`,
 * `Set-Content`), which still write into the project while vellum plans.
 */
export function checkVerdict(tool: string, engine: ResultOf["tool.check"]): ResultOf["tool.check"] {
  return SHELLS.has(tool) && engine.decision === "allow" && engine.rule !== undefined
    ? { ...engine, decision: "ask" }
    : engine;
}
