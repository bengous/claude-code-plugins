import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { labelsFrom } from "../overlay/config.ts";
import type { RegistryEntry } from "../shared/wire.ts";
import { liveEntry, overlayTag } from "./pinpoint.ts";

/** No process has this pid on Linux, whose limit is 2^22. */
const DEAD = 4_194_304 + 1;

const dirs: string[] = [];

/** A registry directory holding each file's text, as `<index>.json`. */
function sessions(...files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pinpoint-vite-"));
  dirs.push(dir);
  files.forEach((text, index) => {
    writeFileSync(join(dir, `${index}.json`), text);
  });

  return dir;
}

function entryOf(root: string, started: number, pid = process.pid): RegistryEntry {
  return {
    version: 1,
    session: `s${started}`,
    root,
    port: 4000 + started,
    token: `t${started}`,
    pid,
    started,
  };
}

function fileOf(root: string, started: number, pid = process.pid): string {
  return JSON.stringify(entryOf(root, started, pid));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("liveEntry", () => {
  test("the newest live session at or above the app's root", () => {
    const dir = sessions(fileOf("/work", 1), fileOf("/work/app", 2), fileOf("/elsewhere", 3));

    expect(liveEntry(dir, "/work/app/game")?.session).toBe("s2");
  });

  test("a server whose process is gone is not one", () => {
    const dir = sessions(fileOf("/work", 1), fileOf("/work", 2, DEAD));

    expect(liveEntry(dir, "/work")?.session).toBe("s1");
  });

  test("a root that only shares a prefix does not hold the app", () => {
    expect(liveEntry(sessions(fileOf("/work/app", 1)), "/work/app2")).toBeNull();
  });

  test("a file that is not an entry is skipped; no directory is no session", () => {
    expect(liveEntry(sessions("{", '{"version":2}', fileOf("/w", 1)), "/w")?.session).toBe("s1");
    expect(liveEntry("/nowhere/at/all", "/w")).toBeNull();
  });
});

describe("overlayTag", () => {
  test("loads the overlay of the session's server", () => {
    expect(overlayTag(entryOf("/w", 1), "/w", undefined)).toEqual({
      tag: "script",
      attrs: { src: "http://127.0.0.1:4001/t/t1/overlay.js", defer: true },
      injectTo: "body",
    });
  });

  test("carries the labels, which the overlay reads back as they were", () => {
    const labels = ["Trop gros", "À revoir, vite", ""];
    const encoded = "Trop%20gros,%C3%80%20revoir%2C%20vite,";

    expect(overlayTag(entryOf("/w", 1), "/w", labels).attrs?.["data-pinpoint-labels"]).toBe(
      encoded,
    );
    expect(labelsFrom(encoded)).toEqual(labels);
  });

  test("with no session, a line in the console says how to start one", () => {
    expect(overlayTag(null, "/w", undefined).children).toContain("Run /pinpoint:start");
  });
});
