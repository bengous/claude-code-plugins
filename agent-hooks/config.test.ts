import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config, Fixer, Lane } from "./config.ts";
import {
  ConfigError,
  DEFAULT_CAP,
  PRESETS_DIR,
  configPath,
  expandCommand,
  isExcluded,
  loadConfig,
  matchesFilter,
  pkgOf,
  splitCommand,
} from "./config.ts";
import { parseJsonc } from "./json.ts";
import type { TempRepo } from "./test-support.ts";
import {
  createTempRepo,
  removeTempRepo,
  scrubGitEnv,
  writeConfig,
  writeRepoFile,
} from "./test-support.ts";

let temp: TempRepo;

beforeEach(() => {
  scrubGitEnv();
  temp = createTempRepo("agent-hooks-config-");
});

afterEach(() => {
  removeTempRepo(temp);
});

function load(jsonc: string): Config {
  writeConfig(temp.repo, jsonc);

  return loadConfig(temp.repo);
}

function configErrorOf(jsonc: string): ConfigError {
  writeConfig(temp.repo, jsonc);

  try {
    loadConfig(temp.repo);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error("expected a ConfigError");
}

function expectConfigError(jsonc: string, keyPath: string): void {
  expect(configErrorOf(jsonc).message).toStartWith(
    `agent-hooks: ${configPath(temp.repo)}: ${keyPath}: `,
  );
}

function fixer(fixers: readonly Fixer[], name: string): Fixer {
  const found = fixers.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`no fixer ${name}`);
  }

  return found;
}

function lane(config: Config, name: string): Lane {
  const found = config.stop.lanes.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`no lane ${name}`);
  }

  return found;
}

function names(entries: ReadonlyArray<{ readonly name: string }>): string[] {
  return entries.map((entry) => entry.name);
}

describe("parseJsonc", () => {
  test("drops line and block comments outside strings", () => {
    const text = `// head
{
  /* block
     comment */
  "a": 1, // trailing
  "b": /* inline */ 2
}`;

    expect(parseJsonc(text)).toEqual({ a: 1, b: 2 });
  });

  test("keeps a // and a /* inside a string", () => {
    expect(parseJsonc('{ "url": "https://example.com", "glob": "a/*.ts" }')).toEqual({
      url: "https://example.com",
      glob: "a/*.ts",
    });
  });

  test("keeps an escaped quote inside a string", () => {
    expect(parseJsonc(String.raw`{ "a": "say \"//hi\"" }`)).toEqual({ a: 'say "//hi"' });
  });

  test("drops trailing commas before } and ]", () => {
    expect(parseJsonc('{ "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  test("drops a trailing comma followed by a comment before the brace", () => {
    expect(parseJsonc('{ "a": 1, // last\n /* end */ }')).toEqual({ a: 1 });
  });

  test("throws on invalid text", () => {
    expect(() => parseJsonc("{ not json }")).toThrow();
  });
});

describe("loadConfig merge", () => {
  test("a repo file without presets loads its own entries", () => {
    const config = load(`{
      "pre-edit": { "fixers": { "fmt": { "on": "**/*.go", "file": "gofmt -w {file}" } } },
      "stop": { "lanes": { "vet": { "on": "**/*.go", "takes": "project", "run": "go vet ./..." } } },
    }`);

    expect(config.preEdit.fixers).toEqual([
      {
        name: "fmt",
        on: "**/*.go",
        exclude: [],
        file: "gofmt -w {file}",
        loop: false,
        disabled: false,
      },
    ]);
    expect(config.stop.lanes).toEqual([
      {
        name: "vet",
        on: "**/*.go",
        exclude: [],
        takes: "project",
        cwd: "root",
        run: "go vet ./...",
        verdict: "block",
        timeoutMs: 60_000,
        disabled: false,
      },
    ]);
  });

  test("merges the presets before the repo file", () => {
    const config = load(`{
      "presets": ["ts"],
      "pre-edit": { "fixers": { "oxlint": { "file": "oxlint --repo {file}" } } },
    }`);

    expect(fixer(config.preEdit.fixers, "oxlint").file).toBe("oxlint --repo {file}");
    expect(fixer(config.preEdit.fixers, "oxlint").loop).toBe(true);
  });

  test("concatenates exclude without duplicates", () => {
    const config = load(
      `{ "presets": ["ts"], "pre-edit": { "exclude": ["**/dist/**", "extra/**"] } }`,
    );

    expect(config.preEdit.exclude).toEqual(["**/node_modules/**", "**/dist/**", "extra/**"]);
  });

  test("merges a lane key by key: a timeout alone keeps the preset's on and run", () => {
    const config = load(
      `{ "presets": ["ts"], "stop": { "lanes": { "test": { "timeout": 180 } } } }`,
    );

    const merged = lane(config, "test");

    expect(merged.on).toBe("**/*.{ts,tsx}");
    expect(merged.run).toBe("bun run test");
    expect(merged.takes).toBe("project");
    expect(merged.timeoutMs).toBe(180_000);
  });

  test("merges a fixer key by key", () => {
    const config = load(
      `{ "presets": ["ts"], "pre-edit": { "fixers": { "prettier": { "exclude": ["docs/**"] } } } }`,
    );

    const merged = fixer(config.preEdit.fixers, "prettier");

    expect(merged.stdin).toBe("prettier --stdin-filepath {path}");
    expect(merged.exclude).toEqual(["docs/**"]);
  });

  test("keeps the fixer order of first declaration", () => {
    const config = load(`{
      "presets": ["ts"],
      "pre-edit": {
        "fixers": {
          "zz": { "on": "**/*.go", "file": "gofmt -w {file}" },
          "prettier": { "loop": true },
          "aa": { "on": "**/*.sh", "stdin": "shfmt" },
        },
      },
    }`);

    expect(names(config.preEdit.fixers)).toEqual(["oxlint", "prettier", "zz", "aa"]);
  });

  test("disabled: true on a fixer and on a lane", () => {
    const config = load(`{
      "presets": ["ts"],
      "pre-edit": { "fixers": { "prettier": { "disabled": true } } },
      "stop": { "lanes": { "lint": { "disabled": true } } },
    }`);

    expect(fixer(config.preEdit.fixers, "prettier").disabled).toBe(true);
    expect(lane(config, "lint").disabled).toBe(true);
    expect(lane(config, "typecheck").disabled).toBe(false);
  });

  test("a disabled lane or fixer needs no on, takes, run or command", () => {
    const config = load(`{
      "pre-edit": { "fixers": { "f": { "disabled": true } } },
      "stop": { "lanes": { "x": { "disabled": true } } },
    }`);

    expect(config.preEdit.fixers).toEqual([
      { name: "f", on: "", exclude: [], loop: false, disabled: true },
    ]);
    expect(lane(config, "x").disabled).toBe(true);
  });

  test('composing ["ts", "rust", "shell"] yields unique lanes with clippy and shellcheck', () => {
    const config = load(`{ "presets": ["ts", "rust", "shell"] }`);
    const laneNames = names(config.stop.lanes);

    expect(new Set(laneNames).size).toBe(laneNames.length);
    expect(laneNames).toContain("clippy");
    expect(laneNames).toContain("shellcheck");
    expect(config.preEdit.exclude.filter((pattern) => pattern === "**/target/**")).toHaveLength(1);
  });

  test("a preset named twice loads once", () => {
    const config = load(`{ "presets": ["ts", "ts"] }`);

    expect(names(config.stop.lanes)).toEqual(["lint", "typecheck", "test"]);
    expect(names(config.preEdit.fixers)).toEqual(["oxlint", "prettier"]);
  });

  test("stop.fixers defaults to the pre-edit fixers", () => {
    const config = load(`{ "presets": ["ts"] }`);

    expect(config.stop.fixers).toEqual(config.preEdit.fixers);
  });

  test('stop.fixers "pre-edit" is the pre-edit fixers', () => {
    const config = load(`{ "presets": ["ts"], "stop": { "fixers": "pre-edit" } }`);

    expect(config.stop.fixers).toEqual(config.preEdit.fixers);
  });

  test('stop.fixers "none" is empty', () => {
    expect(load(`{ "presets": ["ts"], "stop": { "fixers": "none" } }`).stop.fixers).toEqual([]);
  });

  test("stop.fixers as a table is its own list", () => {
    const config = load(`{
      "presets": ["ts"],
      "stop": { "fixers": { "gofmt": { "on": "**/*.go", "file": "gofmt -w {file}" } } },
    }`);

    expect(names(config.stop.fixers)).toEqual(["gofmt"]);
    expect(names(config.preEdit.fixers)).toEqual(["oxlint", "prettier"]);
  });

  test("cap defaults to 3 and the repo overrides it", () => {
    expect(DEFAULT_CAP).toBe(3);
    expect(load(`{ "presets": ["ts"] }`).stop.cap).toBe(3);
    expect(load(`{ "presets": ["ts"], "stop": { "cap": 5 } }`).stop.cap).toBe(5);
  });
});

describe("loadConfig errors", () => {
  test("an unknown key at the top level", () => {
    expectConfigError(`{ "nope": 1 }`, "nope");
  });

  test("an unknown key in stop", () => {
    expectConfigError(`{ "stop": { "nope": 1 } }`, "stop.nope");
  });

  test("an unknown key in a lane", () => {
    expectConfigError(
      `{ "stop": { "lanes": { "x": { "on": "**", "takes": "project", "run": "x", "nope": 1 } } } }`,
      "stop.lanes.x.nope",
    );
  });

  test("an unknown key in a fixer", () => {
    expectConfigError(
      `{ "pre-edit": { "fixers": { "f": { "on": "**", "file": "f", "nope": 1 } } } }`,
      "pre-edit.fixers.f.nope",
    );
  });

  test("a lane without on", () => {
    expectConfigError(
      `{ "stop": { "lanes": { "x": { "takes": "project", "run": "x" } } } }`,
      "stop.lanes.x",
    );
    expect(
      configErrorOf(`{ "stop": { "lanes": { "x": { "takes": "project", "run": "x" } } } }`).message,
    ).toEndWith('missing "on"');
  });

  test("a timeout that is not a number", () => {
    expectConfigError(
      `{ "stop": { "lanes": { "x": { "on": "**", "takes": "project", "run": "x", "timeout": "60" } } } }`,
      "stop.lanes.x.timeout",
    );
  });

  test("a fixer with both file and stdin", () => {
    expectConfigError(
      `{ "pre-edit": { "fixers": { "f": { "on": "**", "file": "a", "stdin": "b" } } } }`,
      "pre-edit.fixers.f",
    );
  });

  test("a fixer with neither file nor stdin", () => {
    expectConfigError(`{ "pre-edit": { "fixers": { "f": { "on": "**" } } } }`, "pre-edit.fixers.f");
  });

  test("takes with a bad value", () => {
    expectConfigError(
      `{ "stop": { "lanes": { "x": { "on": "**", "takes": "all", "run": "x" } } } }`,
      "stop.lanes.x.takes",
    );
  });

  test("an unknown preset", () => {
    const error = configErrorOf(`{ "presets": ["no-such-preset"] }`);

    expect(error.message).toBe(
      `agent-hooks: ${configPath(temp.repo)}: presets: unknown preset "no-such-preset"`,
    );
  });

  test("a repo file with extends", () => {
    expectConfigError(`{ "extends": ["ts"] }`, "extends");
  });

  test("a lane run with {file}", () => {
    expectConfigError(
      `{ "stop": { "lanes": { "x": { "on": "**", "takes": "files", "run": "tool {file}" } } } }`,
      "stop.lanes.x.run",
    );
  });

  test("a fixer with {files}", () => {
    expectConfigError(
      `{ "pre-edit": { "fixers": { "f": { "on": "**", "file": "tool {files}" } } } }`,
      "pre-edit.fixers.f",
    );
  });

  test("invalid JSONC names the file", () => {
    expect(configErrorOf("{ nope").message).toStartWith(
      `agent-hooks: ${configPath(temp.repo)}: invalid JSONC: `,
    );
  });

  test("a missing repo file names the file", () => {
    let message = "";

    try {
      loadConfig(temp.repo);
    } catch (error) {
      message = error instanceof ConfigError ? error.message : "";
    }

    expect(message).toStartWith(`agent-hooks: ${configPath(temp.repo)}: cannot read: `);
  });
});

describe("splitCommand", () => {
  test("splits on spaces", () => {
    expect(splitCommand("  a  b\tc ")).toEqual(["a", "b", "c"]);
  });

  test("keeps single and double quoted arguments with their spaces", () => {
    expect(splitCommand(`tool 'a b' "c d" e`)).toEqual(["tool", "a b", "c d", "e"]);
  });

  test("joins a quoted part to its word", () => {
    expect(splitCommand(`--name="a b" x`)).toEqual(["--name=a b", "x"]);
  });

  test("keeps an empty quoted argument", () => {
    expect(splitCommand(`tool ""`)).toEqual(["tool", ""]);
  });

  test("an empty string has no words", () => {
    expect(splitCommand("")).toEqual([]);
  });
});

describe("expandCommand", () => {
  const vars = { root: "/r", pkg: "/r/p", file: "/r/p/a.ts", path: "p/a.ts" };

  test("fills {root}, {pkg}, {file} and {path}", () => {
    expect(expandCommand("tool -c {root}/x.ts --pkg={pkg} {file} {path}", vars)).toEqual([
      "tool",
      "-c",
      "/r/x.ts",
      "--pkg=/r/p",
      "/r/p/a.ts",
      "p/a.ts",
    ]);
  });

  test("{files} expands to one argument per file, a space in a name included", () => {
    expect(
      expandCommand("tool --x {files} --y", { root: "/r", pkg: "/r", files: ["a b.ts", "c.ts"] }),
    ).toEqual(["tool", "--x", "a b.ts", "c.ts", "--y"]);
  });

  test("a command that is only {files} with no files is null", () => {
    expect(expandCommand("{files}", { root: "/r", pkg: "/r", files: [] })).toBeNull();
    expect(expandCommand("{files}", { root: "/r", pkg: "/r" })).toBeNull();
  });

  test("a command that is only {files} runs the first file as the program", () => {
    expect(expandCommand("{files}", { root: "/r", pkg: "/r", files: ["a.sh", "b"] })).toEqual([
      "a.sh",
      "b",
    ]);
  });

  test("an empty command is null", () => {
    expect(expandCommand("", vars)).toBeNull();
  });
});

describe("pkgOf", () => {
  test("the nearest ancestor with a package.json", () => {
    writeRepoFile(temp.repo, "apps/web/package.json", "{}");
    writeRepoFile(temp.repo, "package.json", "{}");

    expect(pkgOf(temp.repo, "apps/web/src/deep/a.ts")).toBe(path.join(temp.repo, "apps/web"));
  });

  test("the nearest ancestor with a Cargo.toml", () => {
    writeRepoFile(temp.repo, "crates/tool/Cargo.toml", "");

    expect(pkgOf(temp.repo, "crates/tool/src/main.rs")).toBe(path.join(temp.repo, "crates/tool"));
  });

  test("the root when no ancestor holds a manifest", () => {
    mkdirSync(path.join(temp.repo, "src"));

    expect(pkgOf(temp.repo, "src/a.ts")).toBe(temp.repo);
  });

  test("the root itself when it holds a manifest", () => {
    writeRepoFile(temp.repo, "package.json", "{}");

    expect(pkgOf(temp.repo, "src/a.ts")).toBe(temp.repo);
    expect(pkgOf(temp.repo, "a.ts")).toBe(temp.repo);
  });
});

describe("matchesFilter and isExcluded", () => {
  test("brace globs", () => {
    const filter = { on: "**/*.{ts,tsx}", exclude: [] };

    expect(matchesFilter(filter, "src/a.ts")).toBe(true);
    expect(matchesFilter(filter, "src/a.tsx")).toBe(true);
    expect(matchesFilter(filter, "src/a.js")).toBe(false);
  });

  test("** matches the root and nested directories", () => {
    const filter = { on: "**/*.ts", exclude: [] };

    expect(matchesFilter(filter, "a.ts")).toBe(true);
    expect(matchesFilter(filter, "a/b/c/d.ts")).toBe(true);
    expect(matchesFilter({ on: "apps/site/**", exclude: [] }, "apps/site/src/x.svelte")).toBe(true);
    expect(matchesFilter({ on: "apps/site/**", exclude: [] }, "apps/web/x.svelte")).toBe(false);
  });

  test("exclude wins over on", () => {
    const filter = { on: "**/*.ts", exclude: ["**/node_modules/**", "dist/**"] };

    expect(matchesFilter(filter, "node_modules/x/a.ts")).toBe(false);
    expect(matchesFilter(filter, "pkg/node_modules/x/a.ts")).toBe(false);
    expect(matchesFilter(filter, "dist/a.ts")).toBe(false);
    expect(matchesFilter(filter, "src/a.ts")).toBe(true);
  });

  test("isExcluded", () => {
    expect(isExcluded(["a/**", "b/*.{ts,js}"], "b/x.js")).toBe(true);
    expect(isExcluded(["a/**"], "c/x.ts")).toBe(false);
    expect(isExcluded([], "x")).toBe(false);
  });
});

describe("shipped presets and examples", () => {
  const presets = readdirSync(PRESETS_DIR)
    .filter((file) => file.endsWith(".jsonc"))
    .map((file) => file.slice(0, -".jsonc".length));

  const examplesDir = path.join(PRESETS_DIR, "examples");
  const examples = readdirSync(examplesDir).filter((file) => file.endsWith(".jsonc"));

  test("the presets dir holds presets and the examples dir at least 2 examples", () => {
    expect(presets.length).toBeGreaterThan(0);
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  test.each(presets)("preset %s loads", (name) => {
    const config = load(JSON.stringify({ presets: [name] }));

    expect(config.stop.lanes.length + config.preEdit.fixers.length).toBeGreaterThan(0);
  });

  test.each(examples)("example %s loads", (file) => {
    const config = loadConfig(temp.repo, path.join(examplesDir, file));

    expect(config.stop.cap).toBeGreaterThan(0);
  });

  test("the tool-rs example overrides the cap and a lane verdict", () => {
    const config = loadConfig(temp.repo, path.join(examplesDir, "tool-rs.jsonc"));

    expect(config.stop.cap).toBe(2);
    expect(lane(config, "cargo-test").verdict).toBe("note");
    expect(fixer(config.preEdit.fixers, "rustfmt").stdin).toBe("rustfmt --edition 2024");
  });

  test("an error in an example file names that file", () => {
    const file = path.join(temp.dir, "broken.jsonc");
    writeFileSync(file, `{ "stop": { "nope": 1 } }`);

    expect(() => loadConfig(temp.repo, file)).toThrow(
      `agent-hooks: ${file}: stop.nope: unknown key`,
    );
  });
});
