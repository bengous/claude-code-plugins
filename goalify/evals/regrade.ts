import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { gradeCase, loadCases, type RunResult } from "./flow.ts";
import { lineScores } from "./grade.ts";

type Row = RunResult & {
  readonly prompt_id: string;
  readonly rep: number;
  readonly grade: Record<string, number>;
  readonly explanation?: Record<string, string>;
  readonly judge_model?: string;
  readonly judge_usage?: RunResult["usage"];
};

const [variantDir, ...judgeAgain] = process.argv.slice(2);

if (variantDir === undefined) throw new Error("usage: bun regrade.ts <variant dir> [case id ...]");

const cases = await loadCases();

const resultsPath = join(variantDir, "results.jsonl");

// SAFETY: results.jsonl is written by run-eval.mjs, one row per (case, rep) in the Row shape.
const rows = (await readFile(resultsPath, "utf8"))
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Row);

const regraded: Row[] = [];

for (const row of rows) {
  const evalCase = cases.find((candidate) => candidate.id === row.prompt_id);

  if (evalCase === undefined) throw new Error(`no case for row ${row.prompt_id}`);

  const trace = await readFile(
    join(variantDir, "traces", `${row.prompt_id}_rep${row.rep}.json`),
    "utf8",
  );

  // SAFETY: a trace is the Turn[] run-eval.mjs wrote for this row.
  const turns = JSON.parse(trace) as readonly { role: string; content: string }[];
  const output = turns.findLast((turn) => turn.role === "assistant")?.content ?? "";
  const run: RunResult = { ...row, output };

  if (judgeAgain.includes(row.prompt_id)) {
    const graded = await gradeCase(evalCase, run);

    regraded.push({ ...row, ...graded });
    console.error(`${row.prompt_id} rep${row.rep}: judged again`);
  } else {
    const kept = Object.fromEntries(
      Object.entries(row.grade).filter(
        ([metric]) => !["kind_ok", "line_ok", "proof_cmd", "blocker_or", "cap"].includes(metric),
      ),
    );

    regraded.push({ ...row, grade: { ...kept, ...lineScores(output, evalCase.expected) } });
  }
}

await writeFile(resultsPath, regraded.map((row) => JSON.stringify(row)).join("\n") + "\n");

console.error(`${regraded.length} rows rewritten in ${resultsPath}`);
