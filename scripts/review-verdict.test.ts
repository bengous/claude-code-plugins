import { describe, expect, test } from "bun:test";

import { verdictBody, verdictLine, verdictsOf } from "./review-verdict.ts";

const ID = "0123456789abcdef0123456789abcdef01234567";

describe("verdictBody", () => {
  test("puts the marker verdictsOf reads on the first line, the why under it", () => {
    const body = verdictBody(ID, "Why it holds.");

    expect(body).toBe(`${verdictLine(ID)}\nWhy it holds.\n`);
    expect(verdictsOf([{ body, authorAssociation: "OWNER" }])).toEqual(new Set([ID]));
  });
});

describe("verdictsOf", () => {
  test("reads the patch-id of a verdict on a comment's first line, GitHub's CRLF included", () => {
    expect(
      verdictsOf([
        { body: `${verdictLine(ID)}\r\nClean review.`, authorAssociation: "OWNER" },
        { body: verdictLine("f".repeat(40)), authorAssociation: "COLLABORATOR" },
      ]),
    ).toEqual(new Set([ID, "f".repeat(40)]));
  });

  test("ignores a marker below the first line, a malformed one, and one by someone without write access", () => {
    expect(
      verdictsOf([
        { body: `Quoting it:\n${verdictLine(ID)}`, authorAssociation: "OWNER" },
        { body: "<!-- review: clean patch-id=abc -->", authorAssociation: "OWNER" },
        { body: verdictLine(ID), authorAssociation: "CONTRIBUTOR" },
        { body: verdictLine(ID), authorAssociation: "NONE" },
      ]),
    ).toEqual(new Set());
  });
});
