/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the fixtures are branded values (Version, WipDir, ProjectPath) written as literals: the brand is the parser's to grant, and nothing here parses. */
import { describe, expect, test } from "bun:test";

import type { GroupedDoc, Passage, PlanWorkspace } from "../protocol.ts";
import type { Labelled } from "./labels.ts";
import {
  dirLabels,
  docLabel,
  docLabeller,
  nameParts,
  pathLabel,
  planLabel,
  quoteOf,
  whereOf,
} from "./labels.ts";

const CLICKED = { prefix: "", suffix: "", repeated: false };

const WIP = "plans/2026-09-15/wip-4c2a9d93/";

const IN_REVIEW: PlanWorkspace = {
  kind: "inReview",
  dir: WIP as never,
  version: 3 as never,
  batches: 0,
  finalizeError: null,
};

function doc(path: string, group: GroupedDoc["group"] = "artifact"): GroupedDoc {
  return { path, mediaType: "text/markdown", modified: 0, group } as never;
}

function reviewing(docs: readonly GroupedDoc[]): Labelled {
  return { workspace: IN_REVIEW, docs };
}

const PLAN = doc(`${WIP}.review/v3.md`, "plan");

function passage(kind: Passage["kind"], quote: string): Passage {
  return { kind, quote, prefix: "", suffix: "", lines: [3, 5], removed: false };
}

describe("planLabel", () => {
  test("before the first version the plate says draft", () => {
    expect(planLabel({ kind: "drafting", dir: WIP as never, batches: 0 })).toBe("draft");
  });

  test("under review it prints the version", () => {
    expect(planLabel(IN_REVIEW)).toBe("v3");
  });

  test("changes requested keeps the version that was decided", () => {
    expect(planLabel({ kind: "changesRequested", dir: WIP as never, version: 2 as never })).toBe(
      "v2",
    );
  });

  test("once approved it prints the approved version", () => {
    const dir = "plans/2026-09-15/notification-settings/" as never;
    expect(planLabel({ kind: "approved", dir, version: 4 as never, notes: false })).toBe("v4");
  });
});

describe("dirLabels", () => {
  test("a folder alone is its last segment", () => {
    expect(dirLabels(["vellum/.claude/rules"]).get("vellum/.claude/rules")).toBe("rules");
  });

  test("two folders that end alike take as many segments as tell them apart", () => {
    const labels = dirLabels(["vellum/docs", "docs", "vellum/.claude/rules", ".claude/rules"]);

    expect([...labels.values()]).toEqual([
      "vellum/docs",
      "docs",
      "vellum/.claude/rules",
      ".claude/rules",
    ]);
  });

  test("the root is no folder", () => {
    expect(dirLabels(["", "docs"]).size).toBe(1);
  });
});

describe("docLabel", () => {
  test("the plan reads Plan and its version, with no folder", () => {
    expect(docLabel(PLAN, reviewing([]))).toEqual({ name: "Plan v3", dir: null });
  });

  test("an artifact beside the plan has no folder; one in a subfolder shows it", () => {
    const docs = [doc(`${WIP}mockup.html`), doc(`${WIP}screens/dialog.html`)];

    expect(docLabel(docs[0] as GroupedDoc, reviewing(docs))).toEqual({
      name: "mockup.html",
      dir: null,
    });
    expect(docLabel(docs[1] as GroupedDoc, reviewing(docs))).toEqual({
      name: "dialog.html",
      dir: "screens",
    });
  });

  test("two artifacts of one name in two subfolders show what tells the folders apart", () => {
    const docs = [doc(`${WIP}maquettes/apres/f.html`), doc(`${WIP}maquettes/avant/f.html`)];

    expect(docs.map((one) => docLabel(one, reviewing(docs)).dir)).toEqual(["apres", "avant"]);
  });

  test("a cited file shows its folder from the project root, as much of it as is alone", () => {
    const docs = [doc("vellum/docs/architecture.md", "cited"), doc("docs/testing.md", "cited")];

    expect(docs.map((one) => docLabel(one, reviewing(docs)))).toEqual([
      { name: "architecture.md", dir: "vellum/docs" },
      { name: "testing.md", dir: "docs" },
    ]);
  });

  test("while drafting the plan's folder is the plan's own", () => {
    const plan = doc(`${WIP}plan.md`, "plan");
    const docs = [plan, doc(`${WIP}screens/dialog.html`)];

    const view: Labelled = { workspace: { kind: "drafting", dir: WIP as never, batches: 0 }, docs };

    expect(docLabel(plan, view).name).toBe("Plan draft");
    expect(docLabel(docs[1] as GroupedDoc, view).dir).toBe("screens");
  });

  test("before plan.md is written, an artifact is still read beside the plan", () => {
    const transcript = doc(`${WIP}grill-1.md`);

    const view: Labelled = {
      workspace: { kind: "drafting", dir: WIP as never, batches: 0 },
      docs: [transcript],
    };

    expect(docLabel(transcript, view)).toEqual({ name: "grill-1.md", dir: null });
    expect(pathLabel(transcript, view)).toBe("grill-1.md");
  });
});

describe("docLabeller", () => {
  const listed = [
    doc(`${WIP}maquettes/apres/f.html`),
    doc(`${WIP}maquettes/avant/f.html`),
    doc("vellum/docs/architecture.md", "cited"),
    doc("docs/testing.md", "cited"),
  ];

  test("labels the plan, and each group's folders against its own group alone", () => {
    const labelOf = docLabeller(reviewing(listed));

    expect([PLAN, ...listed].map((one) => labelOf(one))).toEqual([
      { name: "Plan v3", dir: null },
      { name: "f.html", dir: "apres" },
      { name: "f.html", dir: "avant" },
      { name: "architecture.md", dir: "vellum/docs" },
      { name: "testing.md", dir: "docs" },
    ]);
  });

  test("reads the listed documents up front, never once per line", () => {
    let reads = 0;

    const view: Labelled = {
      workspace: IN_REVIEW,
      get docs() {
        reads += 1;

        return listed;
      },
    };

    const labelOf = docLabeller(view);
    const upFront = reads;

    for (const one of listed) labelOf(one);

    expect(reads).toBe(upFront);
  });
});

describe("pathLabel", () => {
  test("the plan by its version, an artifact by its path beside the plan, a cited file by its path", () => {
    const docs = [doc(`${WIP}screens/dialog.html`), doc("vellum/README.md", "cited")];

    expect(pathLabel(PLAN, reviewing(docs))).toBe("Plan v3");
    expect(pathLabel(docs[0] as GroupedDoc, reviewing(docs))).toBe("screens/dialog.html");
    expect(pathLabel(docs[1] as GroupedDoc, reviewing(docs))).toBe("vellum/README.md");
  });
});

describe("nameParts", () => {
  test("the extension is the part after the last dot; a name with none, or a dot file, is all stem", () => {
    expect(nameParts("capture-800px-sans-readWindow.png")).toEqual({
      stem: "capture-800px-sans-readWindow",
      ext: ".png",
    });
    expect(nameParts("archive.tar.gz")).toEqual({ stem: "archive.tar", ext: ".gz" });
    expect(nameParts("Makefile")).toEqual({ stem: "Makefile", ext: "" });
    expect(nameParts(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
  });
});

describe("whereOf", () => {
  test("a general comment, one line, a span of lines, several passages", () => {
    expect(whereOf({ kind: "global" })).toBe("general");
    expect(whereOf({ kind: "text", passages: [{ ...passage("prose", "q"), lines: [3, 3] }] })).toBe(
      "line 3",
    );
    expect(
      whereOf({
        kind: "text",
        passages: [passage("prose", "q"), { ...passage("prose", "r"), lines: [9, 9] }],
      }),
    ).toBe("lines 3–5, line 9");
  });

  test("an element by its label, never its selector nor what the feedback says of it", () => {
    const h1 = { heading: "", role: "heading", name: "Roof", openingTag: "<h1>" };
    const notes = { heading: "Roof", role: "", name: "", openingTag: '<label for="notes">' };

    expect(
      whereOf({
        kind: "element",
        elements: [
          {
            selector: "body > main > h1",
            text: "Roof",
            label: "h1",
            context: CLICKED,
            description: h1,
          },
          {
            selector: "label:nth-of-type(2)",
            text: "Notes",
            label: "label",
            context: CLICKED,
            description: notes,
          },
        ],
      }),
    ).toBe("h1, label");
  });
});

describe("quoteOf", () => {
  test("prose is quoted as it is", () => {
    expect(quoteOf(passage("prose", "the network\nreturns"))).toBe("the network\nreturns");
  });

  test("a code block by its first line and its length; a one-line block as it is", () => {
    expect(quoteOf(passage("code", "export type Draft = {\n  readonly id: DraftId;\n};"))).toBe(
      "export type Draft = { (3 lines)",
    );
    expect(quoteOf(passage("code", "bun test"))).toBe("bun test");
  });

  test("a diagram by its kind, or as a diagram when the kind is unknown", () => {
    expect(quoteOf(passage("diagram", "sequenceDiagram"))).toBe("diagram (sequence)");
    expect(quoteOf(passage("diagram", "flowchart LR"))).toBe("diagram (flowchart)");
    expect(quoteOf(passage("diagram", "graph TD"))).toBe("diagram (flowchart)");
    expect(quoteOf(passage("diagram", "zenuml"))).toBe("diagram");
  });
});
