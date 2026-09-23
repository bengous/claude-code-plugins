import { diffLines } from "diff";

import type { Annotation, Passage } from "./feedback.ts";
import type { ProjectPath } from "./paths.ts";

/**
 * Two texts compared line by line, as the runs the page draws and counts. The comparison is
 * jsdiff's; the runs carry both line cursors, so nothing downstream counts lines again.
 */

/** One run of lines, 1-based. `at` is the line of `after` the removed lines sat before. */
export type DiffRun =
  | {
      readonly kind: "same";
      readonly before: number;
      readonly after: number;
      readonly count: number;
    }
  | { readonly kind: "added"; readonly after: number; readonly count: number }
  | {
      readonly kind: "removed";
      readonly before: number;
      readonly at: number;
      readonly lines: readonly string[];
    };

export type LineDiff = readonly DiffRun[];

export function lineDiff(before: string, after: string): LineDiff {
  const runs: DiffRun[] = [];
  let beforeLine = 1;
  let afterLine = 1;

  for (const change of diffLines(before, after)) {
    if (change.removed) {
      const lines = change.value.replace(/\n$/u, "").split("\n");
      runs.push({ kind: "removed", before: beforeLine, at: afterLine, lines });
      beforeLine += change.count;
    } else if (change.added) {
      runs.push({ kind: "added", after: afterLine, count: change.count });
      afterLine += change.count;
    } else {
      runs.push({ kind: "same", before: beforeLine, after: afterLine, count: change.count });
      beforeLine += change.count;
      afterLine += change.count;
    }
  }

  return runs;
}

/** Lines added and removed, as the bar prints them. */
export type ChangeCount = { readonly added: number; readonly removed: number };

export function countChanges(diff: LineDiff): ChangeCount {
  let added = 0;
  let removed = 0;

  for (const run of diff) {
    if (run.kind === "added") added += run.count;

    if (run.kind === "removed") removed += run.lines.length;
  }

  return { added, removed };
}

/** A line no run holds was read from another text: it maps to the last line, so a range stays in order. */
function shiftLine(diff: LineDiff, line: number): number {
  let last = 0;
  let shifted: number | null = null;

  for (const run of diff) {
    if (run.kind !== "removed") last += run.count;

    if (run.kind === "same" && run.before <= line && line < run.before + run.count) {
      shifted = run.after + line - run.before;
    }

    if (run.kind === "removed" && run.before <= line && line < run.before + run.lines.length) {
      shifted = run.at;
    }
  }

  return Math.max(1, Math.min(shifted ?? last, last));
}

/** Total: a kept line maps to its new number, a removed one to where it sat, never past the last line. */
export function shiftLines(
  diff: LineDiff,
  lines: readonly [number, number],
): readonly [number, number] {
  return [shiftLine(diff, lines[0]), shiftLine(diff, lines[1])];
}

function wordsOf(line: string): ReadonlySet<string> {
  return new Set(line.toLowerCase().match(/[\p{L}\p{N}]+/gu));
}

function sharedWords(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  return [...left].filter((word) => right.has(word)).length;
}

/**
 * Which lines of a removed run the added run after it replaced. Each added line replaces one, in
 * order, so where fewer lines were added than removed the others were removed outright: the
 * replaced ones are those sharing the most words with the added lines, the first ones on a tie.
 */
function replacedIn(removed: readonly string[], added: readonly string[]): readonly boolean[] {
  if (added.length >= removed.length) return removed.map(() => true);

  const addedWords = added.map((line) => wordsOf(line));

  const likeness = removed.map((line) => {
    const words = wordsOf(line);

    return addedWords.map((other) => sharedWords(words, other));
  });

  // best[i][j]: the most words shared, pairing the first j added lines with the first i removed.
  const best = [[0, ...added.map(() => -Infinity)]];

  for (const [i, row] of likeness.entries()) {
    const previous = best[i] ?? [];
    best.push(
      previous.map((skip, j) =>
        j === 0 ? 0 : Math.max(skip, (previous[j - 1] ?? -Infinity) + (row[j - 1] ?? 0)),
      ),
    );
  }

  const replaced = removed.map(() => false);
  let j = added.length;

  for (let i = removed.length; i > 0 && j > 0; i -= 1) {
    const previous = best[i - 1] ?? [];
    const paired = (previous[j - 1] ?? -Infinity) + (likeness[i - 1]?.[j - 1] ?? 0);

    if (paired > (previous[j] ?? -Infinity)) {
      replaced[i - 1] = true;
      j -= 1;
    }
  }

  return replaced;
}

/** A line diff as the annotations read it: its runs, and the lines of the text before it took away. */
type LineMap = { readonly runs: LineDiff; readonly gone: ReadonlySet<number> };

/**
 * A removed line no added line replaced is gone: the quote that sat there is gone. A replaced
 * one is not, and `shiftLine` maps it to the lines that took its place.
 */
function lineMap(before: string, after: string): LineMap {
  const runs = lineDiff(before, after);
  const afterLines = after.split("\n");

  const gone = runs.flatMap((run, index) => {
    if (run.kind !== "removed") return [];
    const next = runs[index + 1];

    const added =
      next?.kind === "added" ? afterLines.slice(next.after - 1, next.after - 1 + next.count) : [];

    const replaced = replacedIn(run.lines, added);

    return run.lines.flatMap((_, offset) =>
      replaced[offset] === true ? [] : [run.before + offset],
    );
  });

  return { runs, gone: new Set(gone) };
}

function removedLines(map: LineMap, lines: readonly [number, number]): boolean {
  return map.gone.has(lines[0]) || map.gone.has(lines[1]);
}

function removedWithin(map: LineMap, lines: readonly [number, number]): boolean {
  for (const line of map.gone) {
    if (lines[0] <= line && line <= lines[1]) return true;
  }

  return false;
}

/**
 * Where a passage stands while an edit is unsent, read from the text it lives on to the
 * version's: on the version's lines, or on lines that replaced them; over a line only the edit
 * holds; or `removed`, its lines the version's. Derived at each Done, never stored: the draft
 * keeps `Passage.removed` alone.
 */
type Standing = "version" | "edit" | "removed";

function standingOf(passage: Passage, toVersion: LineMap): Standing {
  if (passage.removed) return "removed";

  return removedWithin(toVersion, passage.lines) ? "edit" : "version";
}

function mapPassages(
  annotations: readonly Annotation[],
  doc: ProjectPath,
  map: (passage: Passage) => readonly Passage[],
): readonly Annotation[] {
  return annotations.flatMap((annotation) => {
    if (annotation.doc !== doc || annotation.anchor.kind !== "text") return [annotation];

    const [first, ...rest] = annotation.anchor.passages.flatMap((passage) => map(passage));

    return first === undefined
      ? []
      : [{ ...annotation, anchor: { kind: "text", passages: [first, ...rest] } }];
  });
}

/** The three texts of a Done: the version's, the one the editor opened on, the one typed. */
export type EditTexts = {
  readonly version: string;
  readonly base: string;
  readonly text: string;
};

/**
 * Done: the text passages of `doc`'s annotations follow their lines through the edit. One on the
 * version's lines whose lines the edit removed is marked `removed` and takes the version's lines,
 * whatever edit it was made on, so the feedback and Discard edit read them as the version's; one
 * already removed is judged against the version again, and comes back on its new line once its
 * text does. One over a line only the edit holds has no version's lines to take: it goes once the
 * edit removes any of its lines, and a comment left with no passage goes whole. Every other
 * annotation is returned as is.
 */
export function shiftAnnotations(
  annotations: readonly Annotation[],
  doc: ProjectPath,
  texts: EditTexts,
): readonly Annotation[] {
  const edit = lineMap(texts.base, texts.text);
  const toVersion = lineMap(texts.base, texts.version);
  const fromVersion = lineMap(texts.version, texts.text);

  return mapPassages(annotations, doc, (passage) => {
    switch (standingOf(passage, toVersion)) {
      case "removed":
        return removedLines(fromVersion, passage.lines)
          ? [passage]
          : [{ ...passage, removed: false, lines: shiftLines(fromVersion.runs, passage.lines) }];
      case "edit":
        return removedWithin(edit, passage.lines)
          ? []
          : [{ ...passage, lines: shiftLines(edit.runs, passage.lines) }];
      case "version":
        return removedLines(edit, passage.lines)
          ? [{ ...passage, removed: true, lines: shiftLines(toVersion.runs, passage.lines) }]
          : [{ ...passage, lines: shiftLines(edit.runs, passage.lines) }];
    }
  });
}

/** The two texts of a Discard edit: the version's, and the edit's it gives up. */
export type DiscardTexts = { readonly version: string; readonly edit: string };

/**
 * Discard edit is a Done that types the version's text back: the passages on the version's lines
 * come back to it, the removed ones are removed no more, their lines intact, and one over a line
 * only the edit holds goes with the edit. A comment left with no passage goes whole.
 */
export function unshiftAnnotations(
  annotations: readonly Annotation[],
  doc: ProjectPath,
  texts: DiscardTexts,
): readonly Annotation[] {
  return shiftAnnotations(annotations, doc, {
    version: texts.version,
    base: texts.edit,
    text: texts.version,
  });
}

export function goneWithEdit(
  annotations: readonly Annotation[],
  doc: ProjectPath,
  texts: DiscardTexts,
): number {
  return annotations.length - unshiftAnnotations(annotations, doc, texts).length;
}
