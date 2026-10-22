import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Inventory, Summary } from "./inventory.ts";
import { FILE_BYTES, inventoryOf, printed } from "./inventory.ts";
import { listed } from "./listing.ts";
import type { Manifest } from "./manifests.ts";
import { ENV_NOTE, IMPORTS_NOTE } from "./scan.ts";

// The fixture repositories are written here, not committed: a committed package.json, Dockerfile
// or compose file would be read as the repository's own by its dependency updates and checks.

const CLI = join(import.meta.dir, "cli.ts");

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "atlas-inventory-")));

afterAll(() => {
  rmSync(TMP, { recursive: true });
});

/** A git that sees only the fixture, whatever GIT_DIR a hook running the suite sets. */
const GIT_ENV = Object.fromEntries(
  Object.entries(process.env).flatMap(([key, value]) =>
    key.startsWith("GIT_") || value === undefined ? [] : [[key, value]],
  ),
);

function repo(name: string, files: Readonly<Record<string, string>>, git: boolean): string {
  const dir = join(TMP, name);

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  if (git && Bun.spawnSync(["git", "init", "-q", dir], { env: GIT_ENV }).exitCode !== 0) {
    throw new Error(`git init ${dir} failed`);
  }

  return dir;
}

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(...args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, CLI, ...args], { env: GIT_ENV });

  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function inventory(dir: string): Inventory {
  const run = cli("inventory", dir);

  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);

  // SAFETY: the command prints an Inventory; the suite's assertions read every field it relies on.
  return JSON.parse(run.stdout) as Inventory;
}

const manifest = (inv: Inventory, path: string): Manifest | undefined =>
  inv.manifests.find((m) => m.path === path);

describe("a TypeScript repository under git", () => {
  const outsideFile = join(TMP, "outside.ts");
  writeFileSync(outsideFile, "export const leak = process.env.OUTSIDE_VAR;\n");

  const dir = repo(
    "shop",
    {
      "package.json": JSON.stringify({
        name: "shop",
        main: "src/server.ts",
        bin: { shop: "bin/shop.ts" },
        scripts: { start: "bun src/server.ts", test: "bun test" },
        workspaces: ["packages/*"],
        dependencies: { hono: "4.0.0" },
        devDependencies: { typescript: "5.0.0" },
      }),
      "packages/db/package.json": JSON.stringify({
        name: "@shop/db",
        exports: { ".": { import: "./index.ts" } },
      }),
      "packages/db/index.ts": "export const url = process.env.DATABASE_URL;\n",
      "src/server.ts": [
        'import { url } from "@shop/db";',
        "import {",
        "  render,",
        '} from "./web/render.ts";',
        'const port = Number(process.env["PORT"] ?? 3000);',
        "",
      ].join("\n"),
      "src/web/render.ts": [
        'import { helper } from "../../lib/helper";',
        "export const render = () => Bun.env.THEME ?? helper;",
        "",
      ].join("\n"),
      "lib/helper.ts": "export const helper = 1;\n",
      "bin/shop.ts":
        'import "../src/server.ts";\nimport "@shop/db/index.ts";\nawait import("../lib/helper.ts");\n',
      "src/generated.ts": `export const big = process.env.BIG_ONE;\n// ${"x".repeat(FILE_BYTES)}\n`,
      ".gitignore": "dist/\n*.log\n",
      "dist/bundle.js": "process.env.IGNORED_BY_GIT;\n",
      "debug.log": "noise\n",
      ".env": "LEAKED_SECRET=1\n",
      ".env.example": "PORT=3000\nexport DATABASE_URL=\n",
      ".github/workflows/ci.yml": [
        "name: CI",
        "on:",
        "  push:",
        "  pull_request:",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: bun test",
        "",
      ].join("\n"),
    },
    true,
  );

  symlinkSync(outsideFile, join(dir, "src", "outside.ts"));

  const inv = inventory(dir);

  test("lists what git lists, .gitignore applied, and reads no link", () => {
    expect(inv.root).toBe(dir);
    expect(inv.listing).toBe("git");
    expect(inv.files).toBe(12);
    expect(inv.languages).toEqual({ JSON: 2, TypeScript: 6, YAML: 1, other: 3 });
    expect(inv.skipped).toEqual({
      tooLarge: ["src/generated.ts"],
      links: ["src/outside.ts"],
      unreadable: [],
      unscanned: 0,
    });
    expect(inv.warnings).toEqual([]);
  });

  test("counts the directories of the top two levels, files at any depth", () => {
    expect(inv.dirs.map(({ path, files }) => [path, files])).toEqual([
      [".github", 1],
      [".github/workflows", 1],
      ["bin", 1],
      ["lib", 1],
      ["packages", 2],
      ["packages/db", 2],
      ["src", 3],
      ["src/web", 1],
    ]);
    expect(inv.dirs.find((d) => d.path === "packages/db")?.languages).toEqual({
      JSON: 1,
      TypeScript: 1,
    });
  });

  test("states the facts of each package.json and workflow", () => {
    expect(manifest(inv, "package.json")).toEqual({
      kind: "package.json",
      path: "package.json",
      name: "shop",
      scripts: { start: "bun src/server.ts", test: "bun test" },
      entries: ["bin/shop.ts", "src/server.ts"],
      workspaces: ["packages/*"],
      dependencies: ["hono"],
    });
    expect(manifest(inv, "packages/db/package.json")).toMatchObject({
      name: "@shop/db",
      entries: ["./index.ts"],
    });
    expect(manifest(inv, ".github/workflows/ci.yml")).toEqual({
      kind: "workflow",
      path: ".github/workflows/ci.yml",
      name: "CI",
      triggers: ["pull_request", "push"],
      jobs: ["test"],
    });
  });

  test("counts imports between directories: relative, multi-line, dynamic, and by workspace name", () => {
    expect(inv.imports).toEqual({
      note: IMPORTS_NOTE,
      edges: [
        { from: "bin", to: "lib", count: 1 },
        { from: "bin", to: "packages/db", count: 1 },
        { from: "bin", to: "src", count: 1 },
        { from: "src", to: "packages/db", count: 1 },
        { from: "src", to: "src/web", count: 1 },
        { from: "src/web", to: "lib", count: 1 },
      ],
    });
  });

  test("names the environment variables read, never a .env file's, an ignored file's nor a link's", () => {
    expect(inv.env.note).toBe(ENV_NOTE);
    expect(inv.env.vars).toEqual([
      { name: "DATABASE_URL", files: [".env.example", "packages/db/index.ts"], count: 2 },
      { name: "PORT", files: [".env.example", "src/server.ts"], count: 2 },
      { name: "THEME", files: ["src/web/render.ts"], count: 1 },
    ]);
  });

  test("prints the same bytes twice, short values on one line", () => {
    const first = cli("inventory", dir);

    expect(cli("inventory", dir).stdout).toBe(first.stdout);
    expect(first.stdout).toBe(`${printed(inv)}\n`);
    expect(first.stdout).toContain(
      '\n    {"path":"bin","files":1,"languages":{"TypeScript":1}},\n',
    );
  });

  test("--summary keeps the manifests, the top-level directories, the edges and the names read", () => {
    const run = cli("inventory", dir, "--summary");

    expect(run.code).toBe(0);

    // SAFETY: the command prints a Summary; the assertions read every field they rely on.
    const summary = JSON.parse(run.stdout) as Summary;

    expect(summary.dirs).toEqual([
      { path: ".github", files: 1 },
      { path: "bin", files: 1 },
      { path: "lib", files: 1 },
      { path: "packages", files: 2 },
      { path: "src", files: 3 },
    ]);
    expect(summary.manifests).toEqual(inv.manifests);
    expect(summary.imports).toEqual(inv.imports.edges);
    expect(summary.env).toEqual(["DATABASE_URL", "PORT", "THEME"]);
    expect(summary.skipped).toEqual({ tooLarge: 1, links: 1, unreadable: 0, unscanned: 0 });
    expect(run.stdout.length).toBeLessThan(cli("inventory", dir).stdout.length);
  });
});

describe("a Python repository outside git", () => {
  const dir = repo(
    "weather",
    {
      "pyproject.toml": [
        "[project]",
        'name = "weather"',
        'dependencies = ["httpx>=0.27", "pydantic"]',
        "",
        "[project.scripts]",
        'weather = "weather.cli:main"',
        "",
      ].join("\n"),
      "requirements-dev.txt": "# tools\npytest==8.0\n-r requirements.txt\nruff\n",
      "src/weather/__init__.py": "",
      "src/weather/cli.py":
        'import os\nfrom weather.api import fetch\nKEY = os.environ["WEATHER_KEY"]\n',
      "src/weather/api.py": "from .cache import get\nimport os\nDIR = os.getenv('CACHE_DIR')\n",
      "src/weather/cache.py": "from os import environ\nTTL = environ.get('CACHE_TTL')\n",
      "tests/test_api.py": "from weather.api import fetch\n",
      "scripts/seed.py": "import json, weather.cache as cache\n",
      "node_modules/left/index.js": "process.env.NEVER_WALKED;\n",
      "src-gen/README.md": "generated\n",
      Dockerfile: [
        "FROM python:3.12-slim AS base",
        "FROM base",
        "ARG BUILD_ID",
        "ENV APP_ENV=prod LOG_LEVEL=info",
        "EXPOSE 8000",
        'CMD ["weather"]',
        "",
      ].join("\n"),
    },
    false,
  );

  const inv = inventory(dir);

  test("walks the folder, past node_modules, each directory before the ones inside it", () => {
    expect(inv.listing).toBe("walk");
    expect(inv.files).toBe(10);
    expect(inv.dirs.map((d) => d.path)).toEqual([
      "scripts",
      "src",
      "src/weather",
      "src-gen",
      "tests",
    ]);
  });

  test("states the project, its requirements and its image", () => {
    expect(manifest(inv, "pyproject.toml")).toEqual({
      kind: "pyproject.toml",
      path: "pyproject.toml",
      name: "weather",
      scripts: { weather: "weather.cli:main" },
      dependencies: ["httpx", "pydantic"],
    });
    expect(manifest(inv, "requirements-dev.txt")).toEqual({
      kind: "requirements",
      path: "requirements-dev.txt",
      dependencies: ["pytest", "ruff"],
    });
    expect(manifest(inv, "Dockerfile")).toEqual({
      kind: "Dockerfile",
      path: "Dockerfile",
      images: ["python:3.12-slim"],
      entries: ['["weather"]'],
      ports: ["8000"],
    });
  });

  test("resolves absolute imports through the top-level package, and relative ones in place", () => {
    expect(inv.imports.edges).toEqual([
      { from: "scripts", to: "src/weather", count: 1 },
      { from: "tests", to: "src/weather", count: 1 },
    ]);
  });

  test("names what Python and the Dockerfile read", () => {
    expect(inv.env.vars.map((v) => [v.name, v.files])).toEqual([
      ["APP_ENV", ["Dockerfile"]],
      ["BUILD_ID", ["Dockerfile"]],
      ["CACHE_DIR", ["src/weather/api.py"]],
      ["CACHE_TTL", ["src/weather/cache.py"]],
      ["LOG_LEVEL", ["Dockerfile"]],
      ["WEATHER_KEY", ["src/weather/cli.py"]],
    ]);
  });
});

describe("an infrastructure repository: compose, Nix, CI", () => {
  const dir = repo(
    "infra",
    {
      "compose.yml": [
        "services:",
        "  proxy:",
        "    image: caddy:2",
        "    ports: ['443:443']",
        "    depends_on: [app]",
        "  app:",
        "    build: { context: ./app }",
        "    command: ['node', 'server.js']",
        "    environment:",
        "      - DATABASE_URL=postgres://db/app",
        "    depends_on:",
        "      db: { condition: service_healthy }",
        "  db:",
        "    image: postgres:16",
        "    environment:",
        "      POSTGRES_PASSWORD: ${DB_PASSWORD:?required}",
        "",
      ].join("\n"),
      "app/Dockerfile": "FROM node:22\n",
      "flake.nix": [
        "{",
        '  inputs.nixpkgs.url = "github:NixOS/nixpkgs";',
        '  inputs = { home-manager.url = "github:nix-community/home-manager"; };',
        "  outputs = { nixpkgs, ... }: {",
        "    nixosConfigurations.server = nixpkgs.lib.nixosSystem { modules = [ ./hosts/server ]; };",
        "  };",
        "}",
        "",
      ].join("\n"),
      "hosts/server/default.nix": [
        "# the server",
        "{ config, pkgs, ... }:",
        "{",
        "  imports = [ ./hardware.nix ../../modules/backup.nix ];",
        "  services.nginx.enable = true;",
        "  services.postgresql = { enable = true; };",
        "}",
        "",
      ].join("\n"),
      "hosts/server/hardware.nix":
        "{ lib, ... }: { boot.loader.grub.enable = lib.mkDefault true; }\n",
      "modules/backup.nix":
        '{ pkgs, ... }: {\n  systemd.services.backup = { script = "restic backup"; };\n}\n',
      "pkgs/tool.nix": '{ stdenv }: stdenv.mkDerivation { name = "tool"; }\n',
      ".gitlab-ci.yml": [
        "stages: [build, deploy]",
        "variables: { X: 1 }",
        ".template: { image: alpine }",
        "build: { stage: build, script: [make] }",
        "deploy: { stage: deploy, script: [make deploy] }",
        "",
      ].join("\n"),
    },
    true,
  );

  const inv = inventory(dir);

  test("states the services of the compose file", () => {
    expect(manifest(inv, "compose.yml")).toEqual({
      kind: "compose",
      path: "compose.yml",
      services: [
        {
          name: "app",
          image: null,
          build: "./app",
          command: "node server.js",
          ports: [],
          dependsOn: ["db"],
        },
        { name: "db", image: "postgres:16", build: null, command: null, ports: [], dependsOn: [] },
        {
          name: "proxy",
          image: "caddy:2",
          build: null,
          command: null,
          ports: ["443:443"],
          dependsOn: ["app"],
        },
      ],
    });
  });

  test("states the flake's inputs and outputs, and each module's imports and services", () => {
    expect(manifest(inv, "flake.nix")).toEqual({
      kind: "flake.nix",
      path: "flake.nix",
      inputs: ["home-manager", "nixpkgs"],
      outputs: ["config server", "nixosConfigurations"],
    });
    expect(manifest(inv, "hosts/server/default.nix")).toEqual({
      kind: "nix module",
      path: "hosts/server/default.nix",
      imports: ["hosts/server/hardware.nix", "modules/backup.nix"],
      services: ["nginx", "postgresql"],
    });
    expect(manifest(inv, "modules/backup.nix")).toMatchObject({ services: ["backup"] });
    expect(manifest(inv, "pkgs/tool.nix")).toBeUndefined();
  });

  test("states the CI's stages and jobs, and the env the deployment reads", () => {
    expect(manifest(inv, ".gitlab-ci.yml")).toEqual({
      kind: "gitlab-ci",
      path: ".gitlab-ci.yml",
      stages: ["build", "deploy"],
      jobs: ["build", "deploy"],
    });
    expect(manifest(inv, "app/Dockerfile")).toMatchObject({ images: ["node:22"] });
    expect(inv.env.vars.map((v) => v.name)).toEqual([
      "DATABASE_URL",
      "DB_PASSWORD",
      "POSTGRES_PASSWORD",
    ]);
    expect(inv.imports.edges).toEqual([]);
  });

  test("a manifest that does not parse says why, and the rest is read", () => {
    const broken = repo(
      "broken",
      { "package.json": "{ nope", "go.mod": "module example.com/x\n" },
      false,
    );

    const read = inventory(broken);

    expect(manifest(read, "package.json")).toMatchObject({
      kind: "package.json",
      path: "package.json",
    });
    expect(manifest(read, "package.json")).toHaveProperty("error");
    expect(manifest(read, "go.mod")).toEqual({
      kind: "go.mod",
      path: "go.mod",
      name: "example.com/x",
      entries: [],
      dependencies: [],
    });
  });
});

const git = (dir: string, ...args: readonly string[]): void => {
  if (Bun.spawnSync(["git", "-C", dir, ...args], { env: GIT_ENV }).exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} in ${dir} failed`);
  }
};

describe("a path it cannot list or read is set aside with its code, and the rest is read", () => {
  test("outside git: a folder it may not read, a name that is not UTF-8, a name with a backslash", () => {
    const dir = repo(
      "odd-walk",
      {
        "ok.ts": "process.env.OK_VAR;\n",
        "back\\slash.ts": "process.env.BACKSLASH_VAR;\n",
        "locked/x.ts": "process.env.LOCKED_VAR;\n",
      },
      false,
    );

    mkdirSync(Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x62, 0xff])]));
    chmodSync(join(dir, "locked"), 0o000);
    const inv = inventory(dir);
    chmodSync(join(dir, "locked"), 0o755);

    expect(inv.files).toBe(2);
    expect(inv.env.vars.map((v) => v.name)).toEqual(["BACKSLASH_VAR", "OK_VAR"]);
    expect(inv.skipped.unreadable).toEqual([
      { path: "b�", code: "ENOENT" },
      { path: "locked", code: "EACCES" },
    ]);
  });

  test("under git: a file whose folder became a file, and one under a loop of links", () => {
    const dir = repo(
      "odd-git",
      { "a/b.ts": "1;\n", "loop/x.ts": "2;\n", "fine.ts": "process.env.FINE_VAR;\n" },
      true,
    );

    git(dir, "add", "-A");
    rmSync(join(dir, "a"), { recursive: true });
    writeFileSync(join(dir, "a"), "now a file\n");
    rmSync(join(dir, "loop"), { recursive: true });
    symlinkSync("loop", join(dir, "loop"));
    const inv = inventory(dir);

    expect(inv.skipped.unreadable).toEqual([
      { path: "a/b.ts", code: "ENOTDIR" },
      { path: "loop/x.ts", code: "ELOOP" },
    ]);
    expect(inv.env.vars.map((v) => v.name)).toEqual(["FINE_VAR"]);
  });
});

describe("what it lists", () => {
  test("outside git, the root's .gitignore applies: names, folders, anchored paths, globs, a path taken back", () => {
    const dir = repo(
      "ignored-walk",
      {
        ".gitignore": "# built\nbuild/\n*.log\n!keep.log\n/secret.py\n**/gen/*.py\n",
        "build/x.py": "",
        "a.log": "",
        "keep.log": "",
        "secret.py": "",
        "sub/secret.py": "",
        "sub/gen/y.py": "",
        "main.py": "",
      },
      false,
    );

    expect(listed(dir).files).toEqual([".gitignore", "keep.log", "main.py", "sub/secret.py"]);
  });

  test("a folder git lists nothing in, though it holds files, says so", () => {
    const outer = repo("enclosing", { ".gitignore": "inner/\n", "inner/a.ts": "1;\n" }, true);
    const inv = inventory(join(outer, "inner"));

    expect(inv.listing).toBe("git");
    expect(inv.files).toBe(0);
    expect(inv.warnings).toEqual([expect.stringContaining("git lists no file in this folder")]);
  });

  test("git runs no hook of the repository's own, its fsmonitor among them", () => {
    const dir = repo("monitored", { "a.ts": "1;\n" }, true);
    const marker = join(TMP, "fsmonitor-ran");
    writeFileSync(join(dir, "hook.sh"), `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    chmodSync(join(dir, "hook.sh"), 0o755);
    git(dir, "add", "a.ts");
    git(dir, "config", "core.fsmonitor", join(dir, "hook.sh"));

    expect(inventory(dir).files).toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  test("go.mod's main packages and requirements, from the files the pass reads, within its limit", () => {
    const dir = repo(
      "go-limit",
      {
        "go.mod": [
          "module example.com/x",
          "",
          "require (",
          "\tgithub.com/a/b v1.0.0 // indirect",
          ")",
          "require c.io/d v2.0.0",
          "",
        ].join("\n"),
        "a/main.go": "package main\n",
        "b/main.go": "package main\n",
        "c/lib.go": "package lib\n",
      },
      false,
    );

    expect(manifest(inventoryOf(dir), "go.mod")).toEqual({
      kind: "go.mod",
      path: "go.mod",
      name: "example.com/x",
      entries: ["a", "b"],
      dependencies: ["c.io/d", "github.com/a/b"],
    });
    expect(manifest(inventoryOf(dir, 1), "go.mod")).toMatchObject({ entries: ["a"] });
  });
});

test("refuses what is no folder", () => {
  const file = join(TMP, "outside.ts");

  expect(cli("inventory", file)).toEqual({
    code: 1,
    stdout: "",
    stderr: `inventory: ${file} is not a folder\n`,
  });
});
