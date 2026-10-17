/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- this module parses Claude Code transcript lines, JSON of an open shape: each record is narrowed field by field through json.ts, and only counts leave it. */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { CONFIG_RELATIVE_PATH } from "./config.ts";
import { HOOK_KINDS } from "./hook.ts";
import { isRecord, recordField, stringField } from "./json.ts";
import { FIX_INSTRUCTION, REPORT_HEADERS } from "./lanes.ts";
import { findRoot } from "./scope.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const HOOKS_FILE = path.join(import.meta.dir, "hooks", "hooks.json");

/** Where a hook's output lands: `additionalContext` and a block reason reach the agent, a `systemMessage` the user. */
export type Channel = "additionalContext" | "block" | "systemMessage";

export type StopOutcome = "passed" | "blocked" | "cancelled" | "errored";

/** One output of the kit's hooks a transcript recorded. */
export type Injection = {
  readonly event: string;
  readonly channel: Channel;
  readonly text: string;
};

export type TranscriptReading = {
  /** Every cwd the transcript's first entry and its hook records name, in order. */
  readonly cwds: readonly string[];
  readonly injections: readonly Injection[];
  /** One per Stop or SubagentStop of the kit. */
  readonly stops: readonly StopOutcome[];
};

/** Whether a hook record's command, or the status message Claude Code records in its place, is the kit's. */
export type KitCommand = (command: string) => boolean;

export type EventTally = {
  readonly event: string;
  readonly channel: Channel;
  readonly count: number;
  readonly chars: number;
};

/** A lane's share of the Stop reports: how many named it, and the characters of its sections. */
export type LaneTally = { readonly lane: string; readonly count: number; readonly chars: number };

export type NoiseReport = {
  readonly days: number;
  /** Transcripts written within the window. */
  readonly read: number;
  /** Those with a cwd under a root holding the config. */
  readonly transcripts: number;
  readonly roots: number;
  readonly events: readonly EventTally[];
  readonly lanes: readonly LaneTally[];
  readonly stops: Readonly<Record<StopOutcome, number>>;
};

export type NoiseOptions = {
  readonly projectsDir: string;
  readonly days: number;
  readonly now?: number;
};

/** A Stop report's text outside any `### <lane>` section: its header, the instruction, the kit's own notes. */
export const NO_LANE = "(no lane)";

const STOP_EVENTS = new Set(["Stop", "SubagentStop"]);

const OUTCOMES = new Map<string, StopOutcome>([
  ["hook_success", "passed"],
  ["hook_blocking_error", "blocked"],
  ["hook_cancelled", "cancelled"],
  ["hook_non_blocking_error", "errored"],
]);

const HOOK_MARK = '"type":"hook_';

const DENIAL_MARK = "hook error: agent-hooks: ";

const CWD_MARK = '"cwd":"';

/** A PreToolUse refusal as Claude Code hands it to the agent in the tool result: no record names the hook. */
const DENIAL = /^PreToolUse:\S+ hook error: (agent-hooks: [\s\S]*)$/u;

const LANE_HEADING = /^### (.+?)(?: \[[^\]]*\])?$/u;

const KIT_LINES = new Set([FIX_INSTRUCTION, ...Object.values(REPORT_HEADERS)]);

const LEGEND =
  "additionalContext and block reasons reach the agent's context; a systemMessage is shown to the user.";

/**
 * The kit's hooks as transcripts name them: a command running one of its subcommands, through the plugin's entry or
 * a link to it, or a status message of the plugin's `hooks.json`, which Claude Code records in place of the command.
 */
export function kitCommands(): KitCommand {
  const subcommands = [...HOOK_KINDS, "pre-bash"].join("|");

  const invocation = new RegExp(
    String.raw`(?:^|[\s/"'])agent-hooks(?:\.ts)?["']?\s+(?:${subcommands})(?=\s|$)`,
    "u",
  );

  const statusMessages = new Set(statusMessagesOf(JSON.parse(readFileSync(HOOKS_FILE, "utf8"))));

  return (command) => statusMessages.has(command) || invocation.test(command);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the parsed hooks.json, walked for its status messages whatever its nesting.
function statusMessagesOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => statusMessagesOf(item));
  }

  if (!isRecord(value)) {
    return [];
  }

  const own = stringField(value, "statusMessage");

  return [
    ...(own === undefined ? [] : [own]),
    ...Object.values(value).flatMap((entry) => statusMessagesOf(entry)),
  ];
}

/**
 * What one transcript recorded of the kit's hooks since `since`. Each output is read once, from the record that names
 * the hook: a hook's stdout in its `hook_success`, a Stop block in its `hook_blocking_error`, a PreToolUse refusal in
 * the tool result it replaced. The `hook_system_message` and `hook_additional_context` records repeat a stdout and
 * name no hook, so they are not read.
 */
export function readTranscript(text: string, since: number, kit: KitCommand): TranscriptReading {
  const cwds = new Set<string>();
  const injections: Injection[] = [];
  const stops: StopOutcome[] = [];

  for (const line of text.split("\n")) {
    const candidate = line.includes(HOOK_MARK) || line.includes(DENIAL_MARK);

    if (!candidate && !(cwds.size === 0 && line.includes(CWD_MARK))) {
      continue;
    }

    const value = parseLine(line);

    if (value === null) {
      continue;
    }

    const cwd = stringField(value, "cwd");

    if (cwd !== undefined) {
      cwds.add(cwd);
    }

    if (!(Date.parse(stringField(value, "timestamp") ?? "") >= since)) {
      continue;
    }

    const attachment =
      value["type"] === "attachment" ? recordField(value, "attachment") : undefined;

    if (attachment !== undefined) {
      readHookRecord(attachment, kit, injections, stops);
    } else if (value["type"] === "user") {
      injections.push(...denialsOf(value));
    }
  }

  return { cwds: [...cwds], injections, stops };
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);

    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function readHookRecord(
  attachment: Record<string, unknown>,
  kit: KitCommand,
  injections: Injection[],
  stops: StopOutcome[],
): void {
  const type = stringField(attachment, "type") ?? "";
  const event = stringField(attachment, "hookEvent");
  const blocking = recordField(attachment, "blockingError");

  const command =
    stringField(attachment, "command") ??
    (blocking === undefined ? undefined : stringField(blocking, "command"));

  if (event === undefined || command === undefined || !kit(command)) {
    return;
  }

  const outcome = OUTCOMES.get(type);

  if (outcome !== undefined && STOP_EVENTS.has(event)) {
    stops.push(outcome);
  }

  if (type === "hook_success") {
    injections.push(...outputsOf(event, stringField(attachment, "stdout") ?? ""));
  }

  const reason = blocking === undefined ? undefined : stringField(blocking, "blockingError");

  if (type === "hook_blocking_error" && reason !== undefined) {
    injections.push({ event, channel: "block", text: reason });
  }
}

/** The outputs of one JSON line a kit hook printed. */
function outputsOf(event: string, stdout: string): Injection[] {
  const output = parseLine(stdout.trim());

  if (output === null) {
    return [];
  }

  const specific = recordField(output, "hookSpecificOutput") ?? {};

  const texts: readonly (readonly [Channel, string | undefined])[] = [
    ["additionalContext", stringField(specific, "additionalContext")],
    ["block", output["decision"] === "block" ? stringField(output, "reason") : undefined],
    [
      "block",
      specific["permissionDecision"] === "deny"
        ? stringField(specific, "permissionDecisionReason")
        : undefined,
    ],
    ["systemMessage", stringField(output, "systemMessage")],
  ];

  return texts.flatMap(([channel, text]) => (text === undefined ? [] : [{ event, channel, text }]));
}

function denialsOf(value: Record<string, unknown>): Injection[] {
  const content = recordField(value, "message")?.["content"];

  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block): Injection[] => {
    const result =
      isRecord(block) && block["is_error"] === true ? stringField(block, "content") : undefined;

    const reason = result === undefined ? undefined : DENIAL.exec(result)?.[1];

    return reason === undefined ? [] : [{ event: "PreToolUse", channel: "block", text: reason }];
  });
}

/**
 * The characters of a Stop report per lane: a section runs from its `### <lane>` heading, `[pkg]` dropped, to the next
 * heading or the next line of the kit's own; the rest goes to NO_LANE. The shares sum to the text's length.
 */
export function laneShares(text: string): Map<string, number> {
  const shares = new Map<string, number>();
  const lines = text.split("\n");
  let lane = NO_LANE;

  for (const [index, line] of lines.entries()) {
    const heading = LANE_HEADING.exec(line)?.[1];

    if (heading !== undefined) {
      lane = heading;
    } else if (KIT_LINES.has(line) || line.startsWith("agent-hooks: ")) {
      lane = NO_LANE;
    }

    shares.set(lane, (shares.get(lane) ?? 0) + line.length + (index < lines.length - 1 ? 1 : 0));
  }

  return shares;
}

/**
 * The outputs of the kit's hooks over the transcripts under `projectsDir` written in the last `days`, each
 * subagent's included, kept when one of its cwds lies under a root holding the config.
 */
export function measureNoise(options: NoiseOptions): NoiseReport {
  const since = (options.now ?? Date.now()) - options.days * DAY_MS;
  const kit = kitCommands();
  const rootOfCwd = new Map<string, string | null>();
  const roots = new Set<string>();

  const events = new Map<string, EventTally>();
  const lanes = new Map<string, LaneTally>();
  const stops: Record<StopOutcome, number> = { passed: 0, blocked: 0, cancelled: 0, errored: 0 };
  const files = transcriptFiles(options.projectsDir, since);
  let transcripts = 0;

  for (const file of files) {
    const reading = readTranscript(readFileSync(file, "utf8"), since, kit);

    const owners = reading.cwds.flatMap((cwd) => {
      const root = rootOfCwd.has(cwd) ? (rootOfCwd.get(cwd) ?? null) : findRoot(cwd);
      rootOfCwd.set(cwd, root);

      return root === null ? [] : [root];
    });

    if (owners.length === 0) {
      continue;
    }

    transcripts += 1;

    for (const root of owners) {
      roots.add(root);
    }

    for (const { event, channel, text } of reading.injections) {
      const key = `${event}\u0000${channel}`;
      const tally = events.get(key) ?? { event, channel, count: 0, chars: 0 };
      events.set(key, { ...tally, count: tally.count + 1, chars: tally.chars + text.length });

      if (STOP_EVENTS.has(event)) {
        for (const [lane, chars] of laneShares(text)) {
          const share = lanes.get(lane) ?? { lane, count: 0, chars: 0 };
          lanes.set(lane, { lane, count: share.count + 1, chars: share.chars + chars });
        }
      }
    }

    for (const outcome of reading.stops) {
      stops[outcome] += 1;
    }
  }

  return {
    days: options.days,
    read: files.length,
    transcripts,
    roots: roots.size,
    events: [...events.values()].toSorted(
      (left, right) =>
        left.event.localeCompare(right.event) || left.channel.localeCompare(right.channel),
    ),
    lanes: [...lanes.values()].toSorted(
      (left, right) => right.chars - left.chars || left.lane.localeCompare(right.lane),
    ),
    stops,
  };
}

/** Every `.jsonl` under the projects directory, at any depth, last written at `since` or later. */
function transcriptFiles(projectsDir: string, since: number): string[] {
  if (!existsSync(projectsDir)) {
    return [];
  }

  return [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: projectsDir, absolute: true })].filter(
    (file) => statSync(file).mtimeMs >= since,
  );
}

/** The report as text: counts and sizes only, never a line of a transcript. */
export function formatNoise(report: NoiseReport): string {
  const { stops } = report;

  return [
    `agent-hooks noise, the last ${plural(report.days, "day")}`,
    `transcripts: ${report.read} read, ${report.transcripts} in ${plural(report.roots, "root")} holding ${CONFIG_RELATIVE_PATH}`,
    "",
    ...table(
      ["event", "channel", "count", "chars"],
      report.events.map((tally) => [
        tally.event,
        tally.channel,
        String(tally.count),
        String(tally.chars),
      ]),
    ),
    "",
    `Stops: ${stops.passed} passed, ${stops.blocked} blocked, ${stops.cancelled} cancelled, ${stops.errored} errored`,
    "",
    ...table(
      ["lane", "reports", "chars"],
      report.lanes.map((tally) => [tally.lane, String(tally.count), String(tally.chars)]),
    ),
    "",
    LEGEND,
    "",
  ].join("\n");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Columns two spaces apart, the last two right-aligned: they hold the numbers. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column >= header.length - 2
          ? cell.padStart(widths[column] ?? 0)
          : cell.padEnd(widths[column] ?? 0),
      )
      .join("  ");

  return [line(header), ...(rows.length === 0 ? ["(none)"] : rows.map((row) => line(row)))];
}
