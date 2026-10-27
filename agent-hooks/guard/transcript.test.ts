/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- these tests build transcript records, JSON lines whose shape Claude Code does not publish: a closed type would assert a schema instead of the reader's behaviour. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { transcriptRecord as record, writeTranscript } from "../test-support.ts";
import type { HumanRead } from "./transcript.ts";
import { readHuman } from "./transcript.ts";

const START = Date.parse("2026-10-19T10:00:00Z");

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "agent-hooks-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(
  records: readonly Record<string, unknown>[],
  promptId: string | undefined = "p-fixture",
): HumanRead {
  return readHuman(writeTranscript(path.join(dir, "t.jsonl"), records, START), promptId);
}

describe("readHuman", () => {
  test("is the human's latest typed message, one queued while the agent worked included", () => {
    expect(read([record("typed")]).latestTyped).toBe("Fix the date parser.");
    expect(read([record("typed"), record("queued-typed")]).latestTyped).toBe(
      "Apply the three review findings.",
    );
  });

  test("skips what the human did not type: a notification, a peer, an approved plan, a tool result, the agent's own words", () => {
    const later = [
      record("notified-user"),
      record("notified-queued"),
      record("peer"),
      record("approved-plan"),
      record("commit-call"),
      record("commit-ok"),
      record("say"),
    ];

    expect(read([record("typed"), ...later]).latestTyped).toBe("Fix the date parser.");
    expect(read(later).latestTyped).toBeNull();
  });

  test("a teammate message read as a main session's is not typed", () => {
    expect(read([record("typed"), record("lead")]).latestTyped).toBe("Fix the date parser.");
  });

  test("says whether a record carries the turn's prompt", () => {
    expect(read([record("say"), record("typed")]).holdsPrompt).toBe(true);
    expect(read([record("typed")], "p-later").holdsPrompt).toBe(false);
    expect(
      readHuman(writeTranscript(path.join(dir, "t.jsonl"), [record("typed")], START), undefined)
        .holdsPrompt,
    ).toBe(false);
  });

  test("skips a line that does not parse, and throws on a file it cannot read", () => {
    const file = writeTranscript(path.join(dir, "t.jsonl"), [record("typed")], START);
    appendFileSync(file, '{"type": "user", "promptSource": "typed", "message": \n');

    expect(readHuman(file, undefined).latestTyped).toBe("Fix the date parser.");
    expect(() => readHuman(path.join(dir, "missing.jsonl"), undefined)).toThrow();
  });
});
