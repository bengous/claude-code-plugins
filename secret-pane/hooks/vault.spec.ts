import { describe, expect, test } from "bun:test";

import { createVault, entered, isInert, mergeTyped, walkStrings } from "./vault.ts";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

describe("tagOf and valueOf", () => {
  test("mints a placeholder naming the variable, stable for the same value", () => {
    const vault = createVault();
    const tag = vault.tagOf("PARENT_REPO_PAT", PAT, 1_700_000_000_000);

    expect(tag).toMatch(/^\[secret-pane:PARENT_REPO_PAT:[0-9a-f]{8}\]$/u);
    expect(vault.tagOf("PARENT_REPO_PAT", PAT, 1_700_000_000_999)).toBe(tag);
    expect(vault.valueOf(tag)).toBe(PAT);
    expect(vault.valueOf("[secret-pane:PARENT_REPO_PAT:00000000]")).toBeUndefined();
  });

  test("two values get two placeholders", () => {
    const vault = createVault();

    expect(vault.tagOf("A", "one-value", 7)).not.toBe(vault.tagOf("B", "another-value", 7));
  });

  test("mintedIn finds a placeholder of this vault in a text, never another one", () => {
    const vault = createVault();
    const tag = vault.tagOf("A", "one-value", 7);

    expect(vault.mintedIn(`A=${tag}\n`)).toBe(tag);
    expect(vault.mintedIn("A=[secret-pane:A:00000000]")).toBeUndefined();
  });

  test("values lists every kept value once", () => {
    const vault = createVault();

    vault.tagOf("A", "one-value", 7);
    vault.tagOf("A", "one-value", 8);
    vault.tagOf("B", "another-value", 7);
    expect(vault.values()).toEqual(["one-value", "another-value"]);
  });

  test("clear forgets every value", () => {
    const vault = createVault();
    const tag = vault.tagOf("A", "one-value", 7);

    vault.clear();
    expect(vault.isEmpty()).toBe(true);
    expect(vault.valueOf(tag)).toBeUndefined();
    expect(vault.hide("one-value")).toBe("one-value");
  });
});

describe("hide", () => {
  test("swaps every kept value for its placeholder, longest first", () => {
    const vault = createVault();
    const short = vault.tagOf("S", "abcdefgh", 7);
    const long = vault.tagOf("L", "abcdefgh-ijkl", 7);

    expect(vault.hide("abcdefgh-ijkl and abcdefgh")).toBe(`${long} and ${short}`);
  });

  test("never rewrites a placeholder, its own or one already in the text", () => {
    const vault = createVault();
    const pat = vault.tagOf("PARENT_REPO_PAT", PAT, 7);

    vault.tagOf("WORD", "secret-p", 7);
    vault.tagOf("NAME", "PARENT_REPO_PAT", 7);
    expect(vault.hide(`token ${PAT}`)).toBe(`token ${pat}`);
    expect(vault.hide(`again ${pat}`)).toBe(`again ${pat}`);
  });

  test("a value with regex characters is matched as text", () => {
    const vault = createVault();
    const tag = vault.tagOf("P", "a.b*c(d)e", 7);

    expect(vault.hide("xa.b*c(d)ex axbbbcde")).toBe(`x${tag}x axbbbcde`);
  });
});

test("isInert holds a token's characters, and none the shell reads", () => {
  expect(isInert(PAT)).toBe(true);
  expect(isInert("AKIA0123:a/b+c=d@e,f.g-h_i")).toBe(true);
  expect(isInert("-starts-with-a-dash")).toBe(false);
  expect(isInert("abc:=def-long")).toBe(false);

  for (const char of [
    " ",
    "'",
    '"',
    "$",
    "`",
    "\\",
    "!",
    "%",
    "*",
    "?",
    "[",
    "~",
    "#",
    "&",
    ";",
    "|",
    "(",
    "{",
    "<",
    "\n",
  ]) {
    expect(isInert(`abcdefgh${char}x`)).toBe(false);
  }
});

test("walkStrings rewrites every string of a plain value and keeps the shape", () => {
  const out = walkStrings({ stdout: "k1", list: ["k1", 2, null], n: 1 }, (s) => s.toUpperCase());

  expect(out).toEqual({ stdout: "K1", list: ["K1", 2, null], n: 1 });
});

describe("mergeTyped", () => {
  test("appends what was typed after the dots kept", () => {
    expect(mergeTyped("abc", "•••d", "•")).toBe("abcd");
  });

  test("a paste over an empty field is the whole value", () => {
    expect(mergeTyped("", PAT, "•")).toBe(PAT);
  });

  test("fewer dots is a deletion at the end", () => {
    expect(mergeTyped("abcd", "••", "•")).toBe("ab");
  });

  test("a clear is an empty value", () => {
    expect(mergeTyped("abcd", "", "•")).toBe("");
  });

  test("an edit in the middle cannot be read", () => {
    expect(mergeTyped("abc", "••x•", "•")).toBeNull();
  });
});

describe("entered", () => {
  test("keeps the value trimmed", () => {
    expect(entered(` ${PAT}\n`)).toEqual({ kind: "kept", value: PAT });
  });

  test("refuses an empty or short value, saying why", () => {
    expect(entered("   ")).toMatchObject({ kind: "refused" });
    expect(entered("1234567")).toMatchObject({ kind: "refused" });
  });
});
