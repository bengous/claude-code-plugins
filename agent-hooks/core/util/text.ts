export function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start);

  return end === -1 ? text.length : end;
}
