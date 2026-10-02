import { describe, expect, test } from "bun:test";

import type { Todo } from "../types/index.d.ts";
import {
  addedTodos,
  ATTRIBUTE_PATHSPECS,
  commentPattern,
  commentTodo,
  DEFAULT_MARKERS,
  displayText,
  formatAge,
  githubWebUrl,
  isExcludedByAttributes,
  isMine,
  isScannedPath,
  issueNumber,
  parseBlame,
  parseGrep,
  parseList,
  parseMarkers,
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
    ["// TODO: windows line\r", { marker: "TODO", tag: null, text: "windows line" }],
    ["/* TODO: fix */ int x = 1;", { marker: "TODO", tag: null, text: "fix" }],
    ["foo();// TODO: glued", { marker: "TODO", tag: null, text: "glued" }],
    ["}// TODO", { marker: "TODO", tag: null, text: "" }],
    ['x = f("a") // TODO: cache', { marker: "TODO", tag: null, text: "cache" }],
    ['print("it\'s") # TODO: escape', { marker: "TODO", tag: null, text: "escape" }],
    [String.raw`s = "say \"hi\"" // TODO: escaped`, { marker: "TODO", tag: null, text: "escaped" }],
    [
      "fn f(&'a self) { // TODO: don't panic here",
      { marker: "TODO", tag: null, text: "don't panic here" },
    ],
    ["(mapcar #'car xs) ; TODO: it's slow", { marker: "TODO", tag: null, text: "it's slow" }],
    ["let x' = 1 -- TODO: isn't strict", { marker: "TODO", tag: null, text: "isn't strict" }],
    [
      "<p>Don't do this</p> <!-- TODO: it's broken -->",
      { marker: "TODO", tag: null, text: "it's broken" },
    ],
    ['throw new Error("see // TODO"); // TODO: real', { marker: "TODO", tag: null, text: "real" }],
    [String.raw`let p = r"C:\dir\"; // TODO: raw`, { marker: "TODO", tag: null, text: "raw" }],
    [
      "# TODO: bell\u0007 and\tescape\u001B",
      { marker: "TODO", tag: null, text: "bell and escape" },
    ],
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
    '      "    // TODO(doctor): mcp/skills checks",',
    '    ["foo();// TODO: glued", { marker: "TODO" }],',
    String.raw`  "src/a.ts\u000010\u0000  // TODO(#12): newer comment",`,
    "x = 'a # TODO'",
    "const body = `  # TODO in a template`;",
  ])("ignores %s", (line) => {
    expect(commentTodo(line, pattern)).toBeNull();
  });

  test("drops what follows a closed comment, a minified line included", () => {
    expect(commentTodo(`/* TODO */ ${"x".repeat(12_000)}`, pattern)?.text).toBe("");
  });

  test("caps a long comment at 200 characters", () => {
    const found = commentTodo(`// TODO ${"x".repeat(12_000)}`, pattern);

    expect(found?.text).toHaveLength(200);
    expect(found?.text.endsWith("…")).toBe(true);
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
  test("reads a list with CRLF line endings", () => {
    expect(parseList("- crlf list item\r\n- second\r\n")).toEqual([
      { line: 1, text: "crlf list item" },
      { line: 2, text: "second" },
    ]);
  });

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

  test("a label drops control characters", () => {
    expect(sourceLabel(todo({ path: "odd\u001Bname.ts", line: 3 }))).toBe("oddname.ts:3");
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

describe("settings and links", () => {
  test("parseMarkers splits on commas and spaces and keeps each word once", () => {
    expect(parseMarkers(" TODO, FIXME  XXX,,TODO ")).toEqual(["TODO", "FIXME", "XXX"]);
    expect(parseMarkers("")).toEqual([]);
  });

  test.each([
    [
      "git@github.com:bengous/claude-code-plugins.git",
      "https://github.com/bengous/claude-code-plugins",
    ],
    [
      "https://github.com/bengous/claude-code-plugins",
      "https://github.com/bengous/claude-code-plugins",
    ],
    ["https://github.com/bengous/dotfiles.git/", "https://github.com/bengous/dotfiles"],
    ["ssh://git@github.com/bengous/repo.git", "https://github.com/bengous/repo"],
    ["git@gitlab.com:team/repo.git", null],
    ["/srv/git/repo.git", null],
  ])("githubWebUrl(%s)", (remote, url) => {
    expect(githubWebUrl(remote)).toBe(url);
  });

  test("issueNumber reads only a #number tag", () => {
    expect(issueNumber("#42")).toBe(42);
    expect(issueNumber("human")).toBeNull();
    expect(issueNumber("#42 later")).toBeNull();
    expect(issueNumber(null)).toBeNull();
  });

  test("isMine matches the author email without case, and counts uncommitted lines", () => {
    expect(isMine(todo({ authorEmail: "Me@Example.com" }), "me@example.com")).toBe(true);
    expect(isMine(todo({ authorEmail: "other@example.com" }), "me@example.com")).toBe(false);
    expect(isMine(todo({ authorEmail: null }), null)).toBe(true);
    expect(isMine(todo({ authorEmail: "me@example.com" }), null)).toBe(false);
  });

  test("isScannedPath follows the scan's exclusions", () => {
    expect(isScannedPath("TODO.md")).toBe(true);
    expect(isScannedPath("docs/notes.md")).toBe(false);
    expect(isScannedPath("src/a.ts")).toBe(true);
    expect(isScannedPath("bin/rewrite-authors")).toBe(true);
    expect(isScannedPath("dir.v2/.bashrc")).toBe(true);
    expect(isScannedPath("patches/fix.patch")).toBe(false);
  });

  test.each([
    ["todos", "unset", true],
    ["linguist-vendored", "set", true],
    ["linguist-generated", "true", true],
    ["todos", "unspecified", false],
    ["todos", "set", false],
    ["linguist-vendored", "false", false],
  ])("isExcludedByAttributes: %s %s is %p", (name, value, isExcluded) => {
    const stdout = `a.ts\0${name}\0${value}\0a.ts\0other\0unset\0`;

    expect(isExcludedByAttributes(stdout)).toBe(isExcluded);
  });

  test("the grep's attribute pathspecs leave out the values isExcludedByAttributes reads", () => {
    expect(ATTRIBUTE_PATHSPECS).toEqual([
      ":(exclude,attr:-todos)",
      ":(exclude,attr:linguist-vendored)",
      ":(exclude,attr:linguist-vendored=true)",
      ":(exclude,attr:linguist-generated)",
      ":(exclude,attr:linguist-generated=true)",
    ]);
  });
});

describe("addedTodos", () => {
  test("finds the comments an edit adds, not the ones it moves", () => {
    const before = ["// TODO: kept", "code();"].join("\n");
    const after = ["code();", "// TODO: kept", "// FIXME(#7): new one"].join("\n");
    expect(addedTodos("src/a.ts", before, after, DEFAULT_MARKERS)).toEqual([
      { marker: "FIXME", tag: "#7", text: "new one", line: 3 },
    ]);
  });

  test("counts a second copy of an existing TODO as added", () => {
    expect(addedTodos("a.sh", "# TODO: x", "# TODO: x\n# TODO: x", DEFAULT_MARKERS)).toHaveLength(
      1,
    );
  });

  test("reads CRLF files", () => {
    expect(
      addedTodos("a.ts", "// TODO: a\r\n", "// TODO: a\r\n// TODO: b\r\n", DEFAULT_MARKERS),
    ).toEqual([{ marker: "TODO", tag: null, text: "b", line: 2 }]);
  });

  test("reads TODO.md as a list", () => {
    expect(addedTodos("TODO.md", "- old item", "- old item\n- new item", DEFAULT_MARKERS)).toEqual([
      { marker: "TODO", tag: null, text: "new item", line: 2 },
    ]);
  });

  test("finds nothing without markers", () => {
    expect(addedTodos("a.ts", "", "// TODO: x", [])).toEqual([]);
  });
});
