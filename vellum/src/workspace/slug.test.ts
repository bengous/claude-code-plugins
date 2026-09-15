/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixtures and expectations here are branded values (Version, ProjectPath, WipDir) written as literals: the brand is the parser's to grant, and the test is what checks the parser. */
import { describe, expect, test } from "bun:test";

import { slugFromFileName, slugFromTitle } from "./slug.ts";

describe("slugFromTitle", () => {
  test("first heading, lowercased, accents stripped, punctuation folded", () => {
    const plan = "intro\n\n# Vellum v1 : relire un plan, écran & revue\n\n## Two\n";
    expect(slugFromTitle(plan)).toEqual({
      ok: true,
      value: "vellum-v1-relire-un-plan-ecran-revue" as never,
    });
  });

  test("a wip- prefix is dropped: the final directory never looks like a working one", () => {
    expect(slugFromTitle("# WIP: notifications")).toEqual({
      ok: true,
      value: "notifications" as never,
    });
  });

  test("no heading is an error", () => {
    expect(slugFromTitle("no heading here").ok).toBe(false);
  });

  test("a heading with no letters is an error", () => {
    expect(slugFromTitle("# ???").ok).toBe(false);
  });
});

describe("slugFromFileName", () => {
  test("uses the plan file's basename", () => {
    expect(slugFromFileName("plans/plan-append-the-line.md")).toEqual({
      ok: true,
      value: "plan-append-the-line" as never,
    });
  });
});
