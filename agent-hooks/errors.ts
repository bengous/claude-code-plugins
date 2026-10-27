// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught error is `unknown` by the language: this is where it is read as a message.
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
