import { describe, expect, test } from "bun:test";

import type { Todo } from "../types/index.d.ts";
import {
  commentPattern,
  commentTodo,
  DEFAULT_MARKERS,
  displayText,
  formatAge,
  parseBlame,
  parseGrep,
  parseList,
  shortenStart,
  sortNewestFirst,
  sourceLabel,
} from "./parse.ts";

const pattern = commentPattern(DEFAULT_MARKERS);

const DAY = 86_400_000;

function todo(fields: Partial<Todo>): Todo {
  return {
    source: "comment",
    path: "src/a.ts",
    line: 1,
    marker: "TODO",
    tag: null,
    text: "text",
    authoredAt: 0,
    commit: null,
    authorEmail: null,
    ...fields,
  };
}

describe("commentTodo", () => {
  test.each([
    ["# TODO: Add more git aliases", { marker: "TODO", tag: null, text: "Add more git aliases" }],
    [
      "    // TODO(doctor): mcp/skills checks",
      { marker: "TODO", tag: "doctor", text: "mcp/skills checks" },
    ],
    ["/* FIXME: leaks a handle */", { marker: "FIXME", tag: null, text: "leaks a handle" }],
    ["   * HACK works around a race", { marker: "HACK", tag: null, text: "works around a race" }],
    ["<!-- TODO(#42) translate -->", { marker: "TODO", tag: "#42", text: "translate" }],
    ["-- TODO: index this column", { marker: "TODO", tag: null, text: "index this column" }],
    ["; TODO: tail call", { marker: "TODO", tag: null, text: "tail call" }],
    ["//! TODO crate docs", { marker: "TODO", tag: null, text: "crate docs" }],
    ["x = 1  # TODO", { marker: "TODO", tag: null, text: "" }],
  ])("reads %s", (line, expected) => {
    expect(commentTodo(line, pattern)).toEqual(expected);
  });

  test.each([
    "const TODO_LIST = [];",
    "TODO: not in a comment",
    "# TODOs pile up here",
    "see https://example.com/#TODO",
    "Avoid leaving lingering `// TODO: Lorem Ipsum` comments",
    'const label = "# TODO";',
  ])("ignores %s", (line) => {
    expect(commentTodo(line, pattern)).toBeNull();
  });

  test("takes the markers it is given", () => {
    expect(commentTodo("# XXX: odd", commentPattern(["XXX"]))).toEqual({
      marker: "XXX",
      tag: null,
      text: "odd",
    });
    expect(commentTodo("# TODO: odd", commentPattern(["XXX"]))).toBeNull();
  });
});

describe("parseGrep", () => {
  test("keeps the comment rows of git grep -z -n output", () => {
    const stdout = [
      "a.sh\u000012\u0000# TODO: first",
      "b.ts\u00003\u0000const TODO_LIST = [];",
      "c d.rs\u00007\u0000// FIXME(x): spaced path",
      "",
    ].join("\n");

    expect(parseGrep(stdout, DEFAULT_MARKERS)).toEqual([
      { path: "a.sh", line: 12, marker: "TODO", tag: null, text: "first" },
      { path: "c d.rs", line: 7, marker: "FIXME", tag: "x", text: "spaced path" },
    ]);
  });
});

describe("parseList", () => {
  test("reads top-level items, unchecked boxes, and cuts long titles at the first colon", () => {
    const text = [
      "# Follow-ups",
      "",
      "- first long item: details",
      "  continuation line",
      "- `dots`: read changed targets",
      "- [ ] open box",
      "- [x] done box",
      "* star item",
      "  - nested item",
    ].join("\n");

    expect(parseList(text)).toEqual([
      { line: 3, text: "first long item" },
      { line: 5, text: "dots: read changed targets" },
      { line: 6, text: "open box" },
      { line: 8, text: "star item" },
    ]);
  });
});

describe("parseBlame", () => {
  test("keys each line's origin by its working-tree line, uncommitted lines without a commit", () => {
    const porcelain = [
      "9b6920bb8d4e6b85dc8012b168a827d4219fd016 235 350 1",
      "author Augustin",
      "author-mail <bengous@protonmail.com>",
      "author-time 1758821481",
      "filename dot_bash.d/20-git-core.bash",
      "\t# TODO: Add more",
      "0000000000000000000000000000000000000000 3 3 1",
      "author Not Committed Yet",
      "author-mail <not.committed.yet>",
      "author-time 1790900000",
      "filename x.ts",
      "\t// TODO: new",
      "",
    ].join("\n");

    expect(parseBlame(porcelain)).toEqual(
      new Map([
        [
          350,
          {
            commit: "9b6920bb",
            authoredAt: 1_758_821_481_000,
            authorEmail: "bengous@protonmail.com",
          },
        ],
        [3, { commit: null, authoredAt: 1_790_900_000_000, authorEmail: null }],
      ]),
    );
  });
});

describe("sortNewestFirst", () => {
  test("orders by date, then the list before comments, then path and line", () => {
    const sorted = sortNewestFirst([
      todo({ text: "old", authoredAt: 1 }),
      todo({ text: "b", authoredAt: 5, path: "b.ts" }),
      todo({ text: "list", authoredAt: 5, source: "list", path: "TODO.md" }),
      todo({ text: "a", authoredAt: 5, path: "a.ts", line: 9 }),
      todo({ text: "a-first", authoredAt: 5, path: "a.ts", line: 2 }),
    ]);

    expect(sorted.map((item) => item.text)).toEqual(["list", "a-first", "a", "b", "old"]);
  });
});

describe("formatAge", () => {
  test.each([
    [0, "today"],
    [DAY - 1, "today"],
    [DAY, "1d"],
    [13 * DAY, "13d"],
    [14 * DAY, "2w"],
    [59 * DAY, "8w"],
    [60 * DAY, "2mo"],
    [364 * DAY, "12mo"],
    [365 * DAY, "1y"],
  ])("%d ms reads %s", (ms, label) => {
    expect(formatAge(ms)).toBe(label);
  });
});

describe("labels", () => {
  test("a list item is named by its file, a comment by its path and line", () => {
    expect(sourceLabel(todo({ source: "list", path: "TODO.md", line: 4 }))).toBe("TODO.md");
    expect(sourceLabel(todo({ path: "machines/vps/nixos/network.nix", line: 2 }))).toBe(
      "machines/vps/nixos/network.nix:2",
    );
  });

  test("shortenStart keeps the end of a long path", () => {
    expect(shortenStart("machines/vps/nixos/network.nix:2", 16)).toBe("…s/network.nix:2");
    expect(shortenStart("a.ts:1", 16)).toBe("a.ts:1");
  });

  test("displayText names FIXME and HACK, and an empty comment", () => {
    expect(displayText(todo({ marker: "FIXME", text: "leak" }))).toBe("FIXME leak");
    expect(displayText(todo({ text: "plain" }))).toBe("plain");
    expect(displayText(todo({ text: "" }))).toBe("(no description)");
  });
});
