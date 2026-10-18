import { expect, test } from "bun:test";

import { folderOf, sessionTitle } from "./view.ts";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function count(text: string): number {
  return Array.from(graphemes.segment(text)).length;
}

test("folderOf: the panel names the session by the last segment of its directory", () => {
  expect(folderOf("/work/u/claude-code-plugins")).toEqual({
    lead: "claude-co",
    tail: "de-plugins",
  });
  expect(folderOf("/work/u/claude-code-plugins/")).toEqual({
    lead: "claude-co",
    tail: "de-plugins",
  });
  expect(folderOf(String.raw`C:\Users\u\Work\shop`)).toEqual({ lead: "", tail: "shop" });
  expect(folderOf("/")).toEqual({ lead: "", tail: "/" });
});

test("folderOf: a long name is kept whole, its last ten graphemes the tail a narrow panel keeps", () => {
  const long =
    "東京渋谷クライアント向けストアフロント決済画面再設計プロジェクト二〇二六年版フロントエンド";

  const { lead, tail } = folderOf(`/work/u/${long}`);

  expect(`${lead}${tail}`).toBe(long);
  expect(tail).toBe("二〇二六年版フロントエンド".slice(-10));
});

test("folderOf: the cut falls between graphemes, never inside one", () => {
  const accented = `${"a".repeat(20)}e\u0301${"b".repeat(9)}`;
  const coder = `${"c".repeat(20)}👩‍💻${"d".repeat(9)}`;

  for (const name of [accented, coder]) {
    const { lead, tail } = folderOf(`/w/${name}`);

    expect(`${lead}${tail}`).toBe(name);
    expect(count(tail)).toBe(10);
    expect(count(lead) + count(tail)).toBe(count(name));
  }

  expect(folderOf(`/w/${accented}`).tail).toBe(`e\u0301${"b".repeat(9)}`);
  expect(folderOf(`/w/${coder}`).tail).toBe(`👩‍💻${"d".repeat(9)}`);
});

test("sessionTitle: the name's hover gives the whole directory", () => {
  expect(sessionTitle("/work/u/claude-code-plugins")).toBe(
    "Batches go to the Claude Code session in /work/u/claude-code-plugins",
  );
});
