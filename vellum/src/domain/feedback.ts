import type { ProjectPath, Version } from "./paths.ts";

/** Where a comment points: the document as a whole, or a quote with its context and source lines. */
export type Anchor =
  | { readonly kind: "global" }
  | {
      readonly kind: "text";
      readonly quote: string;
      readonly prefix: string;
      readonly suffix: string;
      readonly lines: readonly [number, number];
    };

export type Annotation = {
  readonly id: string;
  readonly doc: ProjectPath;
  readonly anchor: Anchor;
  readonly body: string;
};

function indent(body: string): string {
  return body.trim().split("\n").join("\n   ");
}

/** The text Claude reads: one numbered item per comment, the place first, the comment under it. */
export function formatFeedback(annotations: readonly Annotation[], version: Version): string {
  const items = annotations.map((annotation, index) => {
    const { anchor } = annotation;

    const where =
      anchor.kind === "global"
        ? `\`${annotation.doc}\`, general`
        : `\`${annotation.doc}\` lines ${anchor.lines[0]}–${anchor.lines[1]}: "${anchor.quote}"`;

    return `${index + 1}. ${where}\n   ${indent(annotation.body)}`;
  });

  return `# Plan review: changes requested (v${version})\n\n${items.join("\n\n")}\n`;
}
