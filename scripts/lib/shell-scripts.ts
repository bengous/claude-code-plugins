export const SHELL_SHEBANG_RE = /^#!.*\b(?:ba|z|k|da)?sh\b/u;

/** A file is a shell script if it ends in .sh or opens with a shell shebang. */
export async function isShellScript(path: string): Promise<boolean> {
  if (path.endsWith(".sh")) return true;
  const file = Bun.file(path);

  if (!(await file.exists())) return false;
  const head = await file.slice(0, 128).text();

  return SHELL_SHEBANG_RE.test(head.split("\n", 1)[0] ?? "");
}
