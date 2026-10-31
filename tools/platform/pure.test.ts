import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  baseNameOf,
  dirNameOf,
  errnoOf,
  isErrno,
  isInsideRelative,
  isUnder,
  messageOf,
  shellQuote,
} from "./pure.ts";

const POSIX = ["/"];

const WIN32 = ["\\"];

const EITHER = ["/", "\\"];

function coded(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("pure.ts", () => {
  const source = readFileSync(join(import.meta.dir, "pure.ts"), "utf8");

  test("imports nothing, so a mod can import it by value", () => {
    expect(new Bun.Transpiler({ loader: "ts" }).scanImports(source)).toEqual([]);
    expect(source).not.toMatch(/\bimport\b|\brequire\s*\(/u);
  });

  test("names no runtime a mod lacks", () => {
    expect(source).not.toMatch(/\bBun\.|\bprocess\.|\bNodeJS\b/u);
  });
});

describe("shellQuote", () => {
  test("single-quotes every word, an empty one included", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("a b $HOME `x`")).toBe("'a b $HOME `x`'");
  });

  test("writes each single quote as '\\''", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("''")).toBe(`''\\'''\\'''`);
  });
});

describe("errnoOf", () => {
  test("reads a Node error's code", () => {
    expect(errnoOf(coded("ENOENT"))).toBe("ENOENT");
  });

  test("reads the errno a mod's $.fs ends its message on", () => {
    expect(errnoOf(new Error("todos: $.fs.stat(/x) failed: ENOENT"))).toBe("ENOENT");
    expect(errnoOf(new Error("vellum: $.fs.stat(/x) failed: ENOTDIR"))).toBe("ENOTDIR");
  });

  test("prefers the code to the message", () => {
    expect(errnoOf(coded("EACCES", "x failed: ENOENT"))).toBe("EACCES");
  });

  test("is null for an error that carries neither, and for what is no error", () => {
    expect(errnoOf(new Error("$.fs.stat: /net/x refused: a network location"))).toBeNull();
    expect(errnoOf(new Error("failed: ENOENT, then more"))).toBeNull();
    expect(errnoOf(coded("ENOENT").message)).toBeNull();
    expect(errnoOf({ code: "ENOENT" })).toBeNull();
    expect(errnoOf(null)).toBeNull();
  });
});

describe("isErrno", () => {
  test("matches any of the codes, in either form", () => {
    expect(isErrno(coded("ENOTEMPTY"), "ENOENT", "ENOTEMPTY")).toBe(true);
    expect(isErrno(new Error("x failed: ENOENT"), "ENOENT")).toBe(true);
  });

  test("refuses another code, and an error with none", () => {
    expect(isErrno(coded("EACCES"), "ENOENT")).toBe(false);
    expect(isErrno(new Error("ENOENT"), "ENOENT")).toBe(false);
    expect(isErrno(coded("ENOENT"))).toBe(false);
  });
});

describe("messageOf", () => {
  test("an error's message, anything else as a string", () => {
    expect(messageOf(new TypeError("bad"))).toBe("bad");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf(42)).toBe("42");
    expect(messageOf(undefined)).toBe("undefined");
  });
});

describe("isInsideRelative", () => {
  test("the root itself and a name that starts with two dots are inside", () => {
    expect(isInsideRelative("", POSIX)).toBe(true);
    expect(isInsideRelative("..env", POSIX)).toBe(true);
    expect(isInsideRelative("a/..b/c", POSIX)).toBe(true);
  });

  test("a whole .. segment is outside, wherever it stands", () => {
    expect(isInsideRelative("..", POSIX)).toBe(false);
    expect(isInsideRelative("../x", POSIX)).toBe(false);
    expect(isInsideRelative("a/../../x", POSIX)).toBe(false);
  });

  test("an absolute path is outside", () => {
    expect(isInsideRelative("/etc/passwd", POSIX)).toBe(false);
    expect(isInsideRelative("D:\\x", WIN32)).toBe(false);
    expect(isInsideRelative("D:/x", EITHER)).toBe(false);
    expect(isInsideRelative("\\\\server\\share", WIN32)).toBe(false);
  });

  test("on POSIX a backslash and a drive letter are parts of a name", () => {
    expect(isInsideRelative("..\\x", POSIX)).toBe(true);
    expect(isInsideRelative("C:\\x", POSIX)).toBe(true);
    expect(isInsideRelative("..\\x", WIN32)).toBe(false);
  });

  test("a drive letter without a separator is a relative name", () => {
    expect(isInsideRelative("C:x", WIN32)).toBe(true);
  });
});

describe("isUnder", () => {
  test("a path past the root's separator is under it", () => {
    expect(isUnder("/a", "/a/b", "/")).toBe(true);
    expect(isUnder("/a/", "/a/b", "/")).toBe(true);
    expect(isUnder("/", "/x", "/")).toBe(true);
    expect(isUnder("C:\\a", "C:\\a\\b", "\\")).toBe(true);
  });

  test("a sibling that shares the root's spelling is not", () => {
    expect(isUnder("/a", "/ab", "/")).toBe(false);
  });

  test("the root is not under itself", () => {
    expect(isUnder("/a", "/a", "/")).toBe(false);
    expect(isUnder("/a", "/a/", "/")).toBe(false);
    expect(isUnder("/", "/", "/")).toBe(false);
  });

  test("a .. segment refuses the path, even where it would land under the root", () => {
    expect(isUnder("/a", "/a/../b", "/")).toBe(false);
    expect(isUnder("/a", "/a/b/../c", "/")).toBe(false);
    expect(isUnder("/a", "/a/..b", "/")).toBe(true);
  });

  test("only the separator passed counts", () => {
    expect(isUnder("C:\\a", "C:\\a/b", "\\")).toBe(false);
  });
});

describe("baseNameOf and dirNameOf", () => {
  test("split at the last separator of either kind", () => {
    expect([baseNameOf("/a/b.md"), dirNameOf("/a/b.md")]).toEqual(["b.md", "/a"]);
    expect([baseNameOf("C:\\x\\y.ts"), dirNameOf("C:\\x\\y.ts")]).toEqual(["y.ts", "C:\\x"]);
    expect([baseNameOf("C:\\x/y.ts"), dirNameOf("C:\\x/y.ts")]).toEqual(["y.ts", "C:\\x"]);
  });

  test("a path with no separator is its own name, and has no directory", () => {
    expect([baseNameOf("x"), dirNameOf("x")]).toEqual(["x", null]);
  });

  test("a separator that leads the path is the root, and a trailing one leaves no name", () => {
    expect([baseNameOf("/x"), dirNameOf("/x")]).toEqual(["x", "/"]);
    expect([baseNameOf("\\x"), dirNameOf("\\x")]).toEqual(["x", "/"]);
    expect([baseNameOf("a/"), dirNameOf("a/")]).toEqual(["", "a"]);
  });
});
