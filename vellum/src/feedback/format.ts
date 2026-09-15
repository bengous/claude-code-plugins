import type { Annotation } from "../protocol.ts";
import type { Version } from "../workspace/paths.ts";

function indent(body: string): string {
  return body.trim().split("\n").join("\n   ");
}

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
