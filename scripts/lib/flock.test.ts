import { afterEach, beforeEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { holdLock } from "./flock.fixture.ts";
import { tryLock, unlock } from "./flock.ts";

let dir = "";

let opened: number[] = [];

const open = () => {
  const fd = openSync(join(dir, "lock"), "a");
  opened.push(fd);

  return fd;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flock-"));
  opened = [];
});

afterEach(() => {
  for (const fd of opened) closeSync(fd);
  rmSync(dir, { recursive: true, force: true });
});

test("one open file alone holds the exclusive lock", () => {
  const first = open();
  const second = open();

  expect(tryLock(first, "exclusive")).toBe(true);
  expect(tryLock(second, "exclusive")).toBe(false);
  expect(tryLock(second, "shared")).toBe(false);
});

test("shared locks go together and keep the exclusive one out", () => {
  const first = open();
  const second = open();
  const third = open();

  expect(tryLock(first, "shared")).toBe(true);
  expect(tryLock(second, "shared")).toBe(true);
  expect(tryLock(third, "exclusive")).toBe(false);
});

test("closing the holder's file frees the lock", () => {
  const first = open();
  const second = open();

  expect(tryLock(first, "exclusive")).toBe(true);
  closeSync(opened.shift() ?? first);

  expect(tryLock(second, "exclusive")).toBe(true);
});

test("unlock frees it while the file stays open", () => {
  const first = open();
  const second = open();

  expect(tryLock(first, "exclusive")).toBe(true);
  unlock(first);

  expect(tryLock(second, "exclusive")).toBe(true);
});

test("a lock another process holds keeps this one out until that process ends", async () => {
  const held = await holdLock(join(dir, "lock"));
  const fd = open();

  expect(tryLock(fd, "exclusive")).toBe(false);
  expect(tryLock(fd, "shared")).toBe(false);
  await held.release();

  expect(tryLock(fd, "exclusive")).toBe(true);
});
