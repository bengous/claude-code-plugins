import type { HttpResponse } from "claude-code";

import type { ChannelLine, GateAnswer, PlanWorkspace, ServerLine } from "../protocol.ts";
import type { ServerInfo, Session } from "./mode.ts";
import type { Relayed } from "./relay.ts";

declare const brand: unique symbol;

type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type SessionId = Brand<string, "SessionId">;

export type Token = Brand<string, "Token">;

/** Absolute: the directory the review server was started in. */
export type ProjectDir = Brand<string, "ProjectDir">;

/** Relative to the project, trailing slash kept. */
export type Workdir = Brand<string, "Workdir">;

/**
 * A server type as it crosses HTTP: every brand the domain mints falls back to the value it
 * wraps, since the module reads the server's JSON and grants none of the server's brands.
 * A field the server adds or renames fails the parser below, which is what holds the two ends
 * together.
 *
 * `object` is tested first on purpose: a brand is a primitive intersected with an object, so
 * that arm catches it while a bare `kind: "none"` falls through and keeps its literal.
 */
export type Json<T> = T extends object
  ? T extends readonly (infer U)[]
    ? readonly Json<U>[]
    : T extends string
      ? string
      : T extends number
        ? number
        : { readonly [K in keyof T]: Json<T[K]> }
  : T;

export type WorkspaceWire = Json<PlanWorkspace>;

export type ChannelLineWire = Json<ChannelLine>;

export type ChannelEntryWire = ChannelLineWire["entry"];

/** Distributes over the workspace's variants: each keeps its `kind`, and its `version` where it has one. */
type StageOf<W> = W extends { readonly kind: infer K; readonly version: infer V }
  ? { readonly kind: K; readonly version: V }
  : W extends { readonly kind: infer K }
    ? { readonly kind: K }
    : never;

/** Where the plan stands, as much of the workspace as the band draws. */
export type StageWire = StageOf<WorkspaceWire>;

/**
 * A line of the server's stdout as the module reads it: `ready` as the server it names and its
 * channel's identity, a `stage` as the band draws it and where the review lives.
 */
export type ServerLineWire =
  | { readonly type: "ready"; readonly info: ServerInfo; readonly channel: string }
  | { readonly type: "channel"; readonly line: ChannelLineWire }
  | { readonly type: "stage"; readonly stage: StageWire; readonly dir: Workdir };

/** What `POST /api/gate` answers: the version the browser shows, or why it shows none. */
export type GateWire = Json<GateAnswer>;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- this file IS the boundary parser the rules ask for: a tool call's input, `$.store` values and the server's JSON arrive as `unknown`, there is no earlier place to parse them, and the brands above are minted here and nowhere else. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function sessionId(raw: string): SessionId {
  return raw as SessionId;
}

export function projectDir(raw: string): ProjectDir {
  return raw as ProjectDir;
}

export function workdirOf(id: SessionId, date: string): Workdir {
  return `plans/${date}/wip-${id.slice(0, 8)}/` as Workdir;
}

/** What a shell tool runs: `Monitor` always in the background, Bash and PowerShell by `run_in_background`. */
export type ShellCall = { readonly command: string; readonly background: boolean };

/** The shell call of `input`, or `null`; the caller reads it for a tool of `SHELLS` alone. */
export function shellCall(tool: string, input: unknown): ShellCall | null {
  if (!isRecord(input) || typeof input.command !== "string") return null;

  return {
    command: input.command,
    background: tool === "Monitor" || input.run_in_background === true,
  };
}

/** The file a call would write, for the three tools that write one; `null` for every other. */
export function editedPath(tool: string, input: unknown): string | null {
  if (!isRecord(input)) return null;

  if (tool === "NotebookEdit") {
    return typeof input.notebook_path === "string" ? input.notebook_path : null;
  }

  if (tool !== "Edit" && tool !== "Write") return null;

  return typeof input.file_path === "string" ? input.file_path : null;
}

export function parseServerInfo(value: unknown): ServerInfo | null {
  return isRecord(value) &&
    typeof value.port === "number" &&
    typeof value.token === "string" &&
    typeof value.pid === "number"
    ? { port: value.port, token: value.token as Token, pid: value.pid }
    : null;
}

export function parseSession(value: unknown): Session | null {
  const server = isRecord(value) ? parseServerInfo(value.server) : null;

  return server !== null &&
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.project === "string" &&
    typeof value.workdir === "string" &&
    (value.final === null || typeof value.final === "string") &&
    typeof value.pinnedCwd === "boolean"
    ? {
        id: value.id as SessionId,
        server,
        project: value.project as ProjectDir,
        workdir: value.workdir as Workdir,
        final: value.final as Workdir | null,
        pinnedCwd: value.pinnedCwd,
      }
    : null;
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** What the store kept for this channel; another channel's reads as nothing relayed. */
export function parseRelayed(value: unknown, channel: string): Relayed {
  return isRecord(value) && value.channel === channel && isCount(value.seq)
    ? { channel, seq: value.seq }
    : { channel, seq: 0 };
}

function parseEntry(value: unknown): ChannelEntryWire | null {
  if (!isRecord(value)) return null;

  if (value.kind === "sent") {
    return typeof value.file === "string" ? { kind: "sent", file: value.file } : null;
  }

  if (value.kind === "text") {
    return typeof value.from === "string" && typeof value.text === "string"
      ? { kind: "text", from: value.from, text: value.text }
      : null;
  }

  return value.kind === "approved" &&
    typeof value.version === "number" &&
    typeof value.dir === "string" &&
    (value.notes === null || typeof value.notes === "string")
    ? { kind: "approved", version: value.version, dir: value.dir, notes: value.notes }
    : null;
}

function parseChannelLine(value: unknown): ChannelLineWire | null {
  const entry = isRecord(value) ? parseEntry(value.entry) : null;

  return entry !== null && isRecord(value) && isCount(value.seq) && value.seq > 0
    ? { seq: value.seq, entry }
    : null;
}

function parseStage(value: unknown): StageWire | null {
  if (!isRecord(value)) return null;

  if (value.kind === "drafting") return { kind: "drafting" };

  if (typeof value.version !== "number") return null;

  if (value.kind === "inReview") return { kind: "inReview", version: value.version };

  if (value.kind === "approved") return { kind: "approved", version: value.version };

  return null;
}

/**
 * One line of the server's stdout; `null` for a line this module does not read, which the caller
 * logs: read as nothing, an entry would never reach Claude.
 */
export function parseServerLine(text: string): ServerLineWire | null {
  const value = parseJson(text);

  if (!isRecord(value)) return null;

  if (value.type === "ready") {
    const info = parseServerInfo(value);

    const channel =
      typeof value.channel === "string" && value.channel !== "" ? value.channel : null;

    if (info === null || channel === null) return null;

    // Held to the server's own line: a field it adds or renames fails the typecheck here.
    const ready = { ...info, channel } satisfies Omit<
      Json<Extract<ServerLine, { type: "ready" }>>,
      "type"
    >;

    return { type: "ready", info, channel: ready.channel };
  }

  if (value.type === "channel") {
    const line = parseChannelLine(value.line);

    return line === null ? null : { type: "channel", line };
  }

  const workspace = value.type === "stage" && isRecord(value.workspace) ? value.workspace : null;
  const stage = workspace === null ? null : parseStage(workspace);

  return stage === null || typeof workspace?.dir !== "string"
    ? null
    : { type: "stage", stage, dir: workspace.dir as Workdir };
}

/**
 * What `GET /api/channel` answers. Throws on an answer it does not read, the shape of another
 * version of the server included: read as no entry, it would drop the reviewer's without a word.
 */
export function parseChannel(text: string): ChannelLineWire[] {
  const value = parseJson(text);

  const lines = Array.isArray(value)
    ? value.map((line: unknown) => parseChannelLine(line))
    : [null];

  if (lines.includes(null)) {
    throw new Error(
      `GET /api/channel answered a shape this module does not read: ${text.slice(0, 200)}`,
    );
  }

  return lines.filter((line) => line !== null);
}

export function parseGate(response: HttpResponse): GateWire {
  const value = parseJson(response.text);

  if (isRecord(value) && typeof value.version === "number" && typeof value.kept === "boolean") {
    return { version: value.version, kept: value.kept };
  }

  return {
    error:
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : `the vellum review server answered ${response.status}`,
  };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion */
