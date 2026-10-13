import { describe, expect, test } from "bun:test";

import { createVault, isShellActive, mergeTyped, publishes, walkStrings } from "./vault.ts";

const PAT = "github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz";

describe("tagOf", () => {
  test("mints a placeholder naming the variable, stable for the same value", () => {
    const vault = createVault();
    const tag = vault.tagOf("PARENT_REPO_PAT", PAT, 1_700_000_000_000);

    expect(tag).toMatch(/^\[secret-pane:PARENT_REPO_PAT:[0-9a-f]{8}\]$/u);
    expect(vault.tagOf("PARENT_REPO_PAT", PAT, 1_700_000_000_999)).toBe(tag);
    expect(vault.isEmpty()).toBe(false);
  });

  test("two values get two placeholders", () => {
    const vault = createVault();

    expect(vault.tagOf("A", "one-value", 7)).not.toBe(vault.tagOf("B", "another", 7));
  });
});

describe("restore", () => {
  test("puts the value in for its placeholder and names what it handed", () => {
    const vault = createVault();
    const tag = vault.tagOf("PAT", PAT, 7);

    expect(vault.restore(`printf '%s' '${tag}' | gh secret set PAT`)).toEqual({
      text: `printf '%s' '${PAT}' | gh secret set PAT`,
      handed: [PAT],
    });
  });

  test("leaves a placeholder it never minted, and hands nothing", () => {
    const text = "echo '[secret-pane:PAT:00000000]'";

    expect(createVault().restore(text)).toEqual({ text, handed: [] });
  });
});

describe("hide", () => {
  test("swaps every known value for its placeholder, longest first", () => {
    const vault = createVault();
    const short = vault.tagOf("S", "abcd", 7);
    const long = vault.tagOf("L", "abcdefgh", 7);

    expect(vault.hide("abcdefgh and abcd")).toBe(`${long} and ${short}`);
  });

  test("hides only the values asked for", () => {
    const vault = createVault();
    const tag = vault.tagOf("A", "first-value", 7);

    vault.tagOf("B", "second-value", 7);
    expect(vault.hide("first-value second-value", ["first-value"])).toBe(`${tag} second-value`);
  });

  test("leaves a value under four characters as printed", () => {
    const vault = createVault();

    vault.tagOf("PIN", "123", 7);
    expect(vault.hide("pin 123")).toBe("pin 123");
  });
});

test("isShellActive flags what the shell would read as code", () => {
  expect(isShellActive(PAT)).toBe(false);
  expect(isShellActive("a b")).toBe(true);
  expect(isShellActive("$(id)")).toBe(true);
  expect(isShellActive("it's")).toBe(true);
});

test("publishes names the commands whose text leaves the machine", () => {
  expect(publishes("git commit -m 'x'")).toBe(true);
  expect(publishes("git -C /r tag v1")).toBe(true);
  expect(publishes("git --work-tree /x commit -m x")).toBe(true);
  expect(publishes("git merge -m 'x' topic")).toBe(true);
  expect(publishes("git revert HEAD")).toBe(true);
  expect(publishes("gh pr create --body x")).toBe(true);
  expect(publishes("gh api repos/o/r")).toBe(true);
  expect(publishes("gh variable set X --body y")).toBe(true);
  expect(publishes("printf '%s' 'x' | gh secret set PAT --repo o/r && gh api repos/o/r")).toBe(
    true,
  );
  expect(publishes("gh secret set PAT --repo o/r")).toBe(false);
  expect(publishes("printf '%s' 'x' | gh --repo o/r secret set PAT")).toBe(false);
  expect(publishes("git status")).toBe(false);
  expect(publishes("curl -H 'Authorization: Bearer x' https://api.github.com/repos/o/r")).toBe(
    false,
  );
});

test("tagFor answers the placeholder of a kept value, nothing for another", () => {
  const vault = createVault();
  const tag = vault.tagOf("PIN", "123", 7);

  expect(vault.tagFor("123")).toBe(tag);
  expect(vault.tagFor("124")).toBeUndefined();
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
});
