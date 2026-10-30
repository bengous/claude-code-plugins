import { describe, expect, test } from "bun:test";

import { closesWithoutComment } from "./gate-pr-close.ts";

describe("closesWithoutComment", () => {
  test.each([
    "gh pr close 12",
    "gh pr close 12 -c ''",
    'gh pr close 12 --comment "   "',
    "gh pr close 12 --comment=",
    "gh pr close 12 -c",
    "gh pr close 12 --delete-branch",
    "git fetch && gh pr close 12",
    "GH_REPO=acme/widgets gh pr close 12",
    "gh pr -R acme/widgets close 12",
    "gh pr --repo=acme/widgets close 12",
    "out=$(gh pr close 12)",
  ])("denies %p", (command) => {
    expect(closesWithoutComment(command)).toBe(true);
  });

  test.each([
    'gh pr close 12 -c "Integrated in dev as 9f504671"',
    "gh pr close 12 -c 'Superseded by #14'",
    'gh pr close 12 --comment "Superseded by #14"',
    "gh pr close 12 --comment=Abandoned",
    'gh pr close 12 -d -R acme/widgets -c "Superseded by #14"',
    'gh pr close 12 --comment "$(cat note.md)"',
    'gh pr close 12 -c "$NOTE"',
    "gh pr view 12",
    "gh issue close 12",
  ])("lets through %p", (command) => {
    expect(closesWithoutComment(command)).toBe(false);
  });
});
