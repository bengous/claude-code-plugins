import { describe, expect, test } from "bun:test";

import { parseHookInput, stripStringLiterals } from "./hook-io.ts";

// -- parseHookInput ----------------------------------------------------------

describe("parseHookInput", () => {
  test("extracts command from valid JSON", () => {
    const input = JSON.stringify({ tool_input: { command: "ls -la" } });
    expect(parseHookInput(input)).toBe("ls -la");
  });

  test("returns null for invalid JSON", () => {
    expect(parseHookInput("not json")).toBeNull();
  });

  test("returns null for missing command", () => {
    expect(parseHookInput(JSON.stringify({ tool_input: {} }))).toBeNull();
  });

  test("returns null for missing tool_input", () => {
    expect(parseHookInput(JSON.stringify({}))).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseHookInput("")).toBeNull();
  });
});

// -- stripStringLiterals -----------------------------------------------------

describe("stripStringLiterals", () => {
  test("strips double-quoted strings", () => {
    expect(stripStringLiterals('echo "git reset --hard" && ls')).toBe('echo "" && ls');
  });

  test("strips single-quoted strings", () => {
    expect(stripStringLiterals("echo 'git push --force' && ls")).toBe("echo '' && ls");
  });

  test("handles escaped quotes in double-quoted strings", () => {
    expect(stripStringLiterals('echo "say \\"git reset --hard\\"" && ls')).toBe('echo "" && ls');
  });

  test("strips heredocs", () => {
    const cmd = `git commit -m "$(cat <<'EOF'
git push --force
git reset --hard
EOF
)"`;

    const result = stripStringLiterals(cmd);
    expect(result).not.toContain("git push --force");
    expect(result).not.toContain("git reset --hard");
  });

  test("leaves unquoted text intact", () => {
    expect(stripStringLiterals("git checkout . && ls")).toBe("git checkout . && ls");
  });

  test("handles mixed quoting styles", () => {
    const cmd = `echo "safe" && echo 'also safe' && git reset --hard`;
    const result = stripStringLiterals(cmd);
    expect(result).toContain("git reset --hard");
    expect(result).not.toContain("safe");
    expect(result).not.toContain("also safe");
  });
});
