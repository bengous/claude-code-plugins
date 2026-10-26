/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- this module reads Claude Code's transcript, JSON lines whose shape the harness does not publish: each record is narrowed here by hand, and a record of another shape is skipped. */
import { readFileSync } from "node:fs";

import { isRecord, recordField, stringField } from "./json.ts";

export type HumanRead = {
  /** The latest message the human typed, one sent while the agent worked included; null when there is none. */
  readonly latestTyped: string | null;
  /** Whether a record carries the prompt the hook fired in: false while the transcript lags behind the turn. */
  readonly holdsPrompt: boolean;
};

const TYPED_SOURCES = new Set(["typed", "queued", "suggestion_accepted"]);

/**
 * Reads the human's latest typed message in the main session's transcript at `file`. A task notification, a peer or
 * teammate message, a tool result and an approved plan are not typed. Throws when the file cannot be read; a line
 * that does not parse is skipped.
 */
export function readHuman(file: string, promptId: string | undefined): HumanRead {
  let latestTyped: string | null = null;
  let holdsPrompt = false;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    const record = parsed(line);

    if (record === null) {
      continue;
    }

    holdsPrompt ||= promptId !== undefined && record["promptId"] === promptId;
    latestTyped = typedText(record) ?? latestTyped;
  }

  return { latestTyped, holdsPrompt };
}

function parsed(line: string): Record<string, unknown> | null {
  try {
    const record: unknown = JSON.parse(line);

    return isRecord(record) ? record : null;
  } catch {
    return null;
  }
}

function typedText(record: Record<string, unknown>): string | null {
  const queued = recordField(record, "attachment");

  if (queued?.["type"] === "queued_command") {
    const prompt = stringField(queued, "prompt") ?? "";
    const origin = recordField(queued, "origin");

    return stringField(origin ?? {}, "kind") === "human" && !isNotification(prompt) ? prompt : null;
  }

  if (stringField(record, "type") !== "user" || record["isMeta"] === true) {
    return null;
  }

  const origin = stringField(recordField(record, "origin") ?? {}, "kind");
  const typed = TYPED_SOURCES.has(stringField(record, "promptSource") ?? "") || origin === "human";
  const content = recordField(record, "message")?.["content"];

  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) => (isRecord(block) ? (stringField(block, "text") ?? "") : ""))
            .join("\n")
        : "";

  return typed && !isNotification(text) ? text : null;
}

function isNotification(text: string): boolean {
  return text.includes("<task-notification>");
}
