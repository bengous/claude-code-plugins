const compiled = new Map<string, RegExp>();

function escapeChar(char: string): string {
  return char.replaceAll(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`);
}

function globSource(pattern: string): string {
  let out = "";
  let index = 0;

  while (index < pattern.length) {
    const char = pattern.charAt(index);
    const braceEnd = char === "{" ? pattern.indexOf("}", index) : -1;

    if (pattern.startsWith("**/", index)) {
      out += "(?:.*/)?";
      index += 3;
    } else if (pattern.startsWith("**", index)) {
      out += ".*";
      index += 2;
    } else if (char === "*") {
      out += "[^/]*";
      index += 1;
    } else if (char === "?") {
      out += "[^/]";
      index += 1;
    } else if (braceEnd === -1) {
      out += escapeChar(char);
      index += 1;
    } else {
      const alternatives = pattern
        .slice(index + 1, braceEnd)
        .split(",")
        .map((alternative) => globSource(alternative));

      out += `(?:${alternatives.join("|")})`;
      index = braceEnd + 1;
    }
  }

  return out;
}

/**
 * `*` stays inside one path segment, `**` crosses segments, `**` then a slash also matches no segment,
 * `?` is one character, `{a,b}` is either. The pattern always matches the whole path.
 */
export function globMatch(pattern: string, path: string): boolean {
  let regex = compiled.get(pattern);

  if (regex === undefined) {
    regex = new RegExp(`^${globSource(pattern)}$`, "u");
    compiled.set(pattern, regex);
  }

  return regex.test(path);
}

/** The folder part of a pattern before its first wildcard: `src/core/` for `src/core/**`. */
export function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?{]/u);
  const head = wildcard === -1 ? pattern : pattern.slice(0, wildcard);

  return head.slice(0, head.lastIndexOf("/") + 1);
}
