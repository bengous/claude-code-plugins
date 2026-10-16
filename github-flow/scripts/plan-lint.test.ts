import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatFindings, lintPlan } from "./plan-lint.ts";

function checks(plan: string): string[] {
  return lintPlan(plan).map(({ check, line }) => `${check}@${line}`);
}

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function planFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plan-lint-"));
  tmpDirs.push(dir);
  const file = join(dir, "plan.md");
  writeFileSync(file, content);

  return file;
}

describe("placeholder", () => {
  test("a placeholder in prose is a finding on its line", () => {
    expect(checks("# Plan\n\n- Storage: TBD after the spike")).toEqual(["placeholder@3"]);
    expect(checks("# Plan\n\nThe target is to be determined.")).toEqual(["placeholder@3"]);
    expect(checks("# Plan\n\nPick one ??? later.")).toEqual(["placeholder@3"]);
    expect(checks("# Plan\n\nEither one, decide at implementation.")).toEqual(["placeholder@3"]);
  });

  test("French placeholders match after a space, where an ASCII \\b would not", () => {
    expect(checks("# Plan\n\nLe format à décider.")).toEqual(["placeholder@3"]);
    expect(checks("# Plan\n\nLe nom reste à définir.")).toEqual(["placeholder@3"]);
    expect(checks("# Plan\n\nOn verra : décider plus tard.")).toEqual(["placeholder@3"]);
  });

  test("a fence nested in a list item is code too, its lines no heading", () => {
    const plan = [
      "1. Run:",
      "",
      "    ```sh",
      "    echo TBD",
      "  ## Open questions",
      "  - Port?",
      "    ```",
    ].join("\n");

    expect(checks(plan)).toEqual([]);
  });

  test("a comment marker inside a code span opens no comment", () => {
    expect(checks("# Plan\n\nThe page opens a comment with `<!--`.\n\nStorage: TBD.")).toEqual([
      "placeholder@5",
    ]);
  });

  test("code, a fence and an HTML comment are not prose", () => {
    const plan = [
      "# Plan",
      "",
      "Grep for `TBD` in the docs.",
      "<!-- TBD: kept out of the rendered plan -->",
      "<!--",
      "TBD",
      "-->",
      "````md",
      "```",
      "TBD",
      "```",
      "````",
    ].join("\n");

    expect(checks(plan)).toEqual([]);
  });

  test("a choice handed out of the plan, or settled on the same line, is no placeholder", () => {
    expect(checks("# Plan\n\nWhere the logs go: to be decided separately.")).toEqual([]);
    expect(checks("# Plan\n\n> À décider hors de ce plan : le dossier d'archive.")).toEqual([]);
    expect(checks("Les « restes à trancher » du grill, tranchés ici :")).toEqual([]);
  });

  test("a heading names a section, it holds no placeholder", () => {
    expect(checks("## Points à trancher\n\n- Port ? Je prendrais 8080.")).toEqual([]);
  });

  test("a word that only sounds settled leaves the placeholder standing", () => {
    expect(checks("Storage: TBD for the closed tickets.")).toEqual(["placeholder@1"]);
    expect(checks("- Format de la réponse : à définir")).toEqual(["placeholder@1"]);
    expect(checks("Les tranches restent à définir.")).toEqual(["placeholder@1"]);
  });

  test("TODO and FIXME name the work to log, not a hole in the plan", () => {
    expect(checks("# Plan\n\nLog unrelated findings as TODO, security ones as FIXME.")).toEqual([]);
  });
});

describe("open-question", () => {
  test("an item that takes no option is a finding on its line", () => {
    const plan = [
      "# Plan",
      "",
      "## Open questions",
      "",
      "- Log each request or aggregate per minute? I would aggregate.",
      "- Keep failed jobs forever, or purge after 30 days?",
      "  Both keep the audit trail.",
      "",
      "## Interfaces",
      "",
      "- Should this item count? It is outside the section.",
    ].join("\n");

    expect(checks(plan)).toEqual(["open-question@6"]);
  });

  test("a stated option, in English or French, settles the item", () => {
    const plan = [
      "## Questions ouvertes",
      "",
      "1. Nom du skill ? Je prendrais `review`.",
      "2. Purge ? Recommandé : jamais.",
      "3. Port? Default: 4000, the one the docs use.",
      "4. Cache? Plutôt non.",
    ].join("\n");

    expect(checks(plan)).toEqual([]);
  });

  test("the question's own words take no option", () => {
    const plan = [
      "## Open questions",
      "",
      "- Faut-il choisir A ou B ?",
      "- Which default port should the server use?",
      "- Il faudra choisir entre A et B.",
    ].join("\n");

    expect(checks(plan)).toEqual(["open-question@3", "open-question@4", "open-question@5"]);
  });

  test("a section written in paragraphs is one question, settled anywhere in it", () => {
    const settled = [
      "## Open questions",
      "",
      "**Q1. Same name, different content.** Two options:",
      "",
      "- **A.** Keep the suffix.",
      "- **B.** Overwrite.",
      "",
      "My recommendation is A.",
    ].join("\n");

    expect(checks(settled)).toEqual([]);
    expect(checks("## Open question\n\nDoes the payload carry the session id?\n")).toEqual([
      "open-question@3",
    ]);
  });

  test("a section that says none, or a heading that says they are settled, has no finding", () => {
    expect(checks("## Open questions\n\nNone.\n")).toEqual([]);
    expect(checks("## Questions ouvertes\n\nAucune pour ce plan.\n")).toEqual([]);
    expect(checks("## Open questions, answered\n\n- Port?\n")).toEqual([]);
    expect(checks("## Questions ouvertes (tranchées)\n\n- Port ?\n")).toEqual([]);
  });

  test("a section says it holds no question in so many words", () => {
    expect(checks("## Open questions\n\nNo open questions.\n")).toEqual([]);
    expect(checks("## Questions ouvertes\n\nAucun point ouvert.\n")).toEqual([]);
    expect(checks("## Questions ouvertes\n\nAucune, à part la décision 1.\n")).toEqual([]);
    expect(
      checks("## Open questions\n\n- Nothing in the docs says whether the port is fixed?"),
    ).toEqual(["open-question@3"]);
    expect(checks("## Questions ouvertes\n\nRien n'indique si le port est fixe ?")).toEqual([
      "open-question@3",
    ]);
  });

  test("a heading that only mentions a settled word stays a questions heading", () => {
    expect(checks("## Questions ouvertes sur les tranches\n\n- Port ?\n")).toEqual([
      "open-question@3",
    ]);
    expect(checks("## Open questions on resolved bugs\n\n- Port?\n")).toEqual(["open-question@3"]);
  });

  test("a subsection belongs to its section, the next sibling heading ends it", () => {
    const plan = [
      "## Open questions",
      "",
      "- Port?",
      "",
      "### Detail",
      "",
      "- Host?",
      "",
      "## Files",
      "",
      "- Name?",
    ].join("\n");

    expect(checks(plan)).toEqual(["open-question@3", "open-question@7"]);
  });
});

describe("formatFindings", () => {
  test("names the line, or the file and line", () => {
    const findings = lintPlan("# Plan\n\nStorage: TBD.\n");

    expect(formatFindings(findings)).toStartWith('line 3: placeholder: "TBD" ');
    expect(formatFindings(findings, "plan.md")).toStartWith("plan.md:3: placeholder: ");
  });
});

describe("CLI", () => {
  const cli = join(import.meta.dir, "plan-lint.ts");

  test("prints each finding and exits 1", () => {
    const file = planFile("# Plan\n\nStorage: TBD.\n");
    const run = Bun.spawnSync(["bun", cli, file]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout.toString()).toStartWith(`${file}:3: placeholder: `);
  });

  test("a clean plan exits 0 in silence", () => {
    const run = Bun.spawnSync(["bun", cli, planFile("# Plan\n\nRename it.\n")]);

    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe("");
  });

  test("no file is a usage error", () => {
    expect(Bun.spawnSync(["bun", cli]).exitCode).toBe(2);
  });
});
