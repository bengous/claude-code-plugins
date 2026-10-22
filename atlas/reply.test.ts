import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplyError, appendReply } from "./reply.ts";
import type { Threads } from "./threads.ts";
import { formatThreads } from "./threads.ts";

const KNOWN = new Set(["backup-restore-untested"]);

async function refusal(reply: Promise<Threads>): Promise<ReplyError | null> {
  try {
    await reply;

    return null;
  } catch (error) {
    if (error instanceof ReplyError) {
      return error;
    }

    throw error;
  }
}

let dir = "";

let file = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "threads-"));
  file = join(dir, "threads.json");
  await Bun.write(file, "{}\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true });
});

describe("appendReply", () => {
  test("adds entries in order and writes the formatted file", async () => {
    await appendReply(file, KNOWN, "backup-restore-untested", "agent", " Aucun banc d'essai. ");

    const threads = await appendReply(
      file,
      KNOWN,
      "backup-restore-untested",
      "human",
      "On garde les deux.",
    );

    expect(threads).toEqual({
      "backup-restore-untested": [
        { who: "agent", text: "Aucun banc d'essai." },
        { who: "human", text: "On garde les deux." },
      ],
    });

    expect(await Bun.file(file).text()).toBe(formatThreads(threads));
  });

  test("refuses an unknown id and leaves the file as it was", async () => {
    const refused = await refusal(appendReply(file, KNOWN, "no-such-point", "agent", "x"));

    expect(refused).toBeInstanceOf(ReplyError);
    expect(await Bun.file(file).text()).toBe("{}\n");
  });

  test("refuses an empty text", async () => {
    const refused = await refusal(
      appendReply(file, KNOWN, "backup-restore-untested", "agent", "  "),
    );

    expect(refused).toBeInstanceOf(ReplyError);
    expect(refused instanceof Error ? refused.message : "").toContain("empty");
  });
});
