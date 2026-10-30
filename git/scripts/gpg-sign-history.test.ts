import { describe, expect, test } from "bun:test";

import type { History, RawCommit } from "./gpg-sign-history.ts";
import {
  differences,
  parseCommit,
  rewriteSet,
  signatureTime,
  signingError,
} from "./gpg-sign-history.ts";

const encoder = new TextEncoder();

const SIGNED_RAW = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "parent 1111111111111111111111111111111111111111",
  "parent 2222222222222222222222222222222222222222",
  "author Ada Lovelace <ada@example.com> 1700000000 +0100",
  "committer Charles Babbage <charles@example.com> 1700003600 -0500",
  "mergetag object 3333333333333333333333333333333333333333",
  " type commit",
  "gpgsig -----BEGIN PGP SIGNATURE-----",
  " ",
  " iHUEABYKAB0WIQ",
  " -----END PGP SIGNATURE-----",
  "",
  "Subject line",
  "",
  "Body with trailing spaces   ",
  "",
].join("\n");

function commit(hash: string, signed: boolean, parents: string[] = []): RawCommit {
  return {
    hash,
    tree: `tree-${hash}`,
    parents,
    author: { name: "A", email: "a@example.com", date: "1700000000 +0100" },
    committer: { name: "C", email: "c@example.com", date: "1700003600 -0500" },
    signed,
    extraHeaders: [],
    message: encoder.encode(`${hash}\n`),
  };
}

function history(commits: RawCommit[]): History {
  return {
    order: commits.map((entry) => entry.hash),
    commits: new Map(commits.map((entry) => [entry.hash, entry])),
  };
}

describe("parseCommit", () => {
  test("reads the headers, skips a multi-line header's continuation, keeps the message bytes", () => {
    const parsed = parseCommit("abc", encoder.encode(SIGNED_RAW));

    expect(parsed.tree).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    expect(parsed.parents).toEqual([
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
    ]);
    expect(parsed.author).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      date: "1700000000 +0100",
    });
    expect(parsed.committer.date).toBe("1700003600 -0500");
    expect(parsed.signed).toBe(true);
    expect(parsed.extraHeaders).toEqual(["mergetag"]);
    expect(new TextDecoder().decode(parsed.message)).toBe(
      "Subject line\n\nBody with trailing spaces   \n",
    );
  });

  test("a commit without gpgsig is unsigned", () => {
    const raw = "tree t\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\n\nm\n";

    expect(parseCommit("abc", encoder.encode(raw)).signed).toBe(false);
  });

  test("an unreadable identity fails with the commit it came from", () => {
    const raw = "tree t\nauthor nobody\ncommitter A <a@x> 1 +0000\n\nm\n";

    expect(() => parseCommit("abc", encoder.encode(raw))).toThrow(
      "commit abc: unreadable author line",
    );
  });
});

describe("rewriteSet", () => {
  test("an unsigned commit and every descendant, parents first, across a merge", () => {
    // a ─ m ─ merge ─ t, and a ─ s ─ merge: s is unsigned on the merged branch.
    const graph = history([
      commit("a", true),
      commit("s", false, ["a"]),
      commit("m", true, ["a"]),
      commit("merge", true, ["m", "s"]),
      commit("t", true, ["merge"]),
    ]);

    expect(rewriteSet(graph)).toEqual(["s", "merge", "t"]);
  });

  test("a fully signed history needs nothing", () => {
    expect(rewriteSet(history([commit("a", true), commit("b", true, ["a"])]))).toEqual([]);
  });
});

describe("differences", () => {
  test("a commit recreated with only a new signature and committer has none", () => {
    const old = commit("x", false, ["p"]);

    const recreated = {
      ...old,
      hash: "y",
      signed: true,
      committer: { ...old.committer, name: "Me" },
    };

    expect(differences(old, recreated)).toEqual([]);
  });

  test("names each field that changed", () => {
    const old = commit("x", false, ["p"]);

    const recreated: RawCommit = {
      ...old,
      tree: "other",
      author: { ...old.author, date: "1 +0000" },
      committer: { ...old.committer, date: "2 +0000" },
      message: encoder.encode("x \n"),
      parents: [],
      extraHeaders: ["encoding"],
    };

    expect(differences(old, recreated)).toEqual([
      "tree",
      "author",
      "committer-date",
      "message",
      "parents",
      "headers",
    ]);
  });
});

describe("signingError", () => {
  test("a missing pinentry, from --pinentry-mode error, is a locked key", () => {
    expect(signingError("[GNUPG:] BEGIN_SIGNING H10\n[GNUPG:] FAILURE sign 67108949")).toBe(
      "key-locked",
    );
  });

  test("an invalid signer is a missing secret key", () => {
    expect(signingError("[GNUPG:] INV_SGNR 9 nobody@example.com\n[GNUPG:] FAILURE sign 17")).toBe(
      "no-secret-key",
    );
  });

  test("any other failure stays generic", () => {
    expect(signingError("[GNUPG:] FAILURE sign 33554433")).toBe("signing-failed");
  });
});

describe("signatureTime", () => {
  test("reads the epoch that follows VALIDSIG's date", () => {
    const status =
      "[GNUPG:] VALIDSIG E9B4A41981A19E54FE65B1D6E214839DF8E3F9C6 2026-10-27 1793089929 0 4 0 1 10 00 5499D3";

    expect(signatureTime(status)).toBe(1_793_089_929);
  });

  test("no VALIDSIG line, no time", () => {
    expect(signatureTime("[GNUPG:] ERRSIG B5690EEEBB952194 1 8 00 1793141592 9 -")).toBeNull();
  });
});
