import { describe, expect, test } from "bun:test";

import { closeArguments, prNumber, reminder } from "./pr-close-reminder.ts";

describe("closeArguments", () => {
  test("a command that closes no pull request is null", () => {
    expect(closeArguments("git status")).toBeNull();
    expect(closeArguments("gh pr view 12")).toBeNull();
    expect(closeArguments("gh pr closed 12")).toBeNull();
    expect(closeArguments("")).toBeNull();
  });

  test("the text after gh pr close, at the start or after a separator", () => {
    expect(closeArguments("gh pr close 12")).toBe("12");
    expect(closeArguments("cd repo && gh pr close #12 --comment done")).toBe("#12 --comment done");
    expect(closeArguments("git fetch; gh  pr   close 7")).toBe("7");
  });

  test("a bare gh pr close has empty arguments", () => {
    expect(closeArguments("gh pr close")).toBe("");
  });
});

describe("prNumber", () => {
  test("reads a bare number, a hashed number and a pull URL", () => {
    expect(prNumber("123")).toBe(123);
    expect(prNumber("#123 --comment x")).toBe(123);
    expect(prNumber("--delete-branch https://github.com/acme/repo/pull/456")).toBe(456);
  });

  test("no number is null", () => {
    expect(prNumber("")).toBeNull();
    expect(prNumber("--delete-branch")).toBeNull();
  });
});

describe("reminder", () => {
  test("names the pull request and the candidate with the ref it was found on", () => {
    const text = reminder(123, { ref: "origin/HEAD", sha: "abc1234" });

    expect(text).toContain("If #123 was integrated");
    expect(text).toContain(
      "Candidate: abc1234, the newest commit on origin/HEAD whose message names #123.",
    );
    expect(text).toContain("If it was abandoned, comment with why it was closed.");
    expect(text).toContain("A `--comment` on the close counts");
  });

  test("says where it looked when no commit names the pull request", () => {
    expect(reminder(123, null)).toContain(
      "No commit message names #123 on origin/HEAD, main, HEAD.",
    );
  });

  test("an unknown number names the pull request the command closed, with no search", () => {
    const text = reminder(null, null);

    expect(text).toContain("If the pull request it closed was integrated");
    expect(text).not.toContain("Candidate");
    expect(text).not.toContain("No commit message");
  });
});
