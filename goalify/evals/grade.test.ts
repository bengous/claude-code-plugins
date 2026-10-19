import { describe, expect, test } from "bun:test";

import { goalLines, judgePrompt, judgeSchema, judgeScores, lineScores } from "./grade.ts";

const CONDITION =
  "/goal The deadline case passes 20 consecutive `bun test --parallel` runs, each summary showing 0 fail, or a blocker outside Claude's control is named with its cause and what was tried. Do not use skip or only. Stop after 25 turns and list what remains.";

describe("lineScores on a condition", () => {
  test("a complete line scores every metric", () => {
    expect(lineScores(CONDITION, "condition")).toEqual({
      kind_ok: 1,
      line_ok: 1,
      proof_cmd: 1,
      blocker_or: 1,
      cap: 1,
    });
  });

  test("a trailing context message does not change the line's scores", () => {
    const output = `${CONDITION}\n\nMessage to send before /goal: the issue text.`;

    expect(lineScores(output, "condition").line_ok).toBe(1);
  });

  test("a fenced condition fails line_ok and keeps the other metrics", () => {
    const output = "```text\n" + CONDITION + "\n```";
    const scores = lineScores(output, "condition");

    expect(scores.kind_ok).toBe(1);
    expect(scores.line_ok).toBe(0);
    expect(scores.proof_cmd).toBe(1);
  });

  test("a label inside the line fails line_ok; one after it does not", () => {
    const after =
      "/goal tests pass `bun test` 0 fail, or a blocker is named with its cause. Stop after 5 turns.\nContext: the repo.";

    expect(lineScores(after, "condition").line_ok).toBe(1);

    const inside =
      "/goal Context: tests pass `bun test` 0 fail, or a blocker is named with its cause. Stop after 5 turns.";

    expect(lineScores(inside, "condition").line_ok).toBe(0);
  });

  test("a blocker written as an instruction is not a second end state", () => {
    const output =
      "/goal `bun test` shows 0 fail. If a command cannot run, name the blocker with its cause. Stop after 10 turns.";

    const scores = lineScores(output, "condition");

    expect(scores.blocker_or).toBe(0);
    expect(scores.cap).toBe(1);
  });

  test("no cap, no command", () => {
    const scores = lineScores(
      "/goal the tests pass and lint is clean, or a blocker is named with its cause.",
      "condition",
    );

    expect(scores.proof_cmd).toBe(0);
    expect(scores.cap).toBe(0);
    expect(scores.line_ok).toBe(0);
  });

  test("two /goal lines or none fail kind_ok", () => {
    expect(lineScores(`${CONDITION}\n${CONDITION}`, "condition")).toEqual({ kind_ok: 0 });
    expect(lineScores("I cannot write this.", "condition")).toEqual({ kind_ok: 0 });
  });

  test("French clauses and a cap phrased as 'after N turns, stop' count", () => {
    const french =
      "/goal `bun test` affiche 0 failed, ou un blocage hors du contrôle de Claude est nommé dans la conversation avec sa cause et ce qui a été essayé. Arrête-toi après 40 tours et liste ce qui reste.";

    expect(lineScores(french, "condition").line_ok).toBe(1);

    const inverted =
      "/goal `bun test` shows 0 fail, or a blocker is named with its cause. If neither end state holds after 20 turns, stop and list what remains.";

    expect(lineScores(inverted, "condition").cap).toBe(1);
  });

  test("a line over 4000 characters fails line_ok", () => {
    const long = CONDITION.replace("Stop after", `${"x".repeat(4000)} Stop after`);

    expect(lineScores(long, "condition").line_ok).toBe(0);
  });
});

describe("lineScores on a refusal", () => {
  test("no /goal line is the expected kind", () => {
    expect(lineScores("No observable end state. Proxies: ...", "refusal")).toEqual({ kind_ok: 1 });
  });

  test("a condition written on a proxy is accepted", () => {
    expect(
      lineScores(`No end state as given; the closest proxy:\n${CONDITION}`, "refusal"),
    ).toEqual({
      kind_ok: 1,
    });
  });

  test("a condition with placeholders to fill in is not", () => {
    const template =
      "/goal Each of these defects is fixed: [DEFECT 1], [DEFECT 2]. Stop after 10 turns.";

    expect(lineScores(template, "refusal")).toEqual({ kind_ok: 0 });
  });
});

describe("lineScores on a blocker list with dotted tokens", () => {
  test("a version or a host name inside the parenthesis does not hide the clause", () => {
    const dotted =
      "/goal `cargo test` prints `0 failed`. Ou un blocage hors du contrôle de Claude (réseau coupé pour crates.io, un compilateur plus récent que 1.97.0 exigé) est nommé dans la conversation avec sa cause et ce qui a été essayé. Arrêt après 20 tours.";

    expect(lineScores(dotted, "condition").blocker_or).toBe(1);
  });

  test("'obstacle' names a blocker too", () => {
    const obstacle =
      "/goal `bun test` shows 0 fail. Ou un obstacle hors du contrôle de Claude est nommé dans la conversation avec sa cause et ce qui a été essayé. Arrêt après 20 tours.";

    expect(lineScores(obstacle, "condition").blocker_or).toBe(1);
  });
});

describe("lineScores on French clauses", () => {
  test("'arrêt après N tours' and 'sinon, un blocage … est nommé' count", () => {
    const french =
      "/goal `cargo test` affiche `0 failed`. Sinon, un blocage hors du contrôle de Claude est nommé dans la conversation avec sa cause et ce qui a été essayé. Arrêt après 25 tours avec la liste de ce qui reste.";

    expect(lineScores(french, "condition").line_ok).toBe(1);
  });
});

describe("lineScores on a contradiction", () => {
  test("a line before the condition is required", () => {
    expect(lineScores(CONDITION, "contradiction").kind_ok).toBe(0);
    expect(
      lineScores(`The skill already exists on the branch.\n\n${CONDITION}`, "contradiction")
        .kind_ok,
    ).toBe(1);
  });
});

describe("goalLines", () => {
  test("finds lines that start with /goal and ignores mentions", () => {
    expect(goalLines("Run /goal later.\n/goal x holds.\n")).toEqual(["/goal x holds."]);
  });
});

describe("judge", () => {
  const evalCase = {
    id: "c",
    tags: ["t"],
    cwd: "empty",
    expected: "condition" as const,
    hints: "h",
    input: "do x",
  };

  test("schema requires a boolean and a reason per property", () => {
    expect(judgeSchema("refusal").required).toEqual(["proxy", "proxy_why"]);
  });

  test("prompt carries the input, the hints and the output as data", () => {
    const prompt = judgePrompt(evalCase, "OUT");

    expect(prompt).toContain("Task the user typed: do x");
    expect(prompt).toContain("Case hints (what a good response does here): h");
    expect(prompt).toContain("<<<\nOUT\n>>>");
  });

  test("scores map booleans to 0/1 and keep the reasons", () => {
    const { grade, explanation } = judgeScores("refusal", {
      proxy: true,
      proxy_why: "offers a Stop hook",
    });

    expect(grade).toEqual({ proxy: 1 });
    expect(explanation).toEqual({ proxy: "offers a Stop hook" });
  });

  test("a missing boolean throws", () => {
    expect(() => judgeScores("refusal", { proxy_why: "x" })).toThrow("proxy");
  });
});
