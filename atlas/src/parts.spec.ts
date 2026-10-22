import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A map written in parts, as /atlas:init writes one: map.ts assembles parts/<branch>.ts, each
// importing its types alone from ../atlas.d.ts. Every command on a map folder reads the parts:
// check's type-check, lint and format-check, fmt, and the page serve.ts bundles and rebuilds.

const CLI = join(import.meta.dir, "cli.ts");

const SERVE = join(import.meta.dir, "serve.ts");

const TMP = realpathSync(mkdtempSync(join(tmpdir(), "atlas-parts-")));

const WAIT_MS = 10_000;

afterAll(() => {
  rmSync(TMP, { recursive: true });
});

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "FORCE_COLOR")),
  NO_COLOR: "1",
};

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

function cli(...args: readonly string[]): Run {
  const run = Bun.spawnSync([process.execPath, CLI, ...args], { env: ENV });

  return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

const part = (branch: string, label: string, linkTo: string): string =>
  [
    'import type { Link, Node } from "../atlas.d.ts";',
    "",
    "export const node = {",
    `  id: "${branch}",`,
    `  label: "${label}",`,
    '  sub: "a branch",',
    '  color: "system",',
    "  children: [",
    "    {",
    `      id: "${branch}-inner",`,
    '      label: "Inner",',
    '      sub: "a part of it",',
    '      color: "system",',
    `      children: [{ id: "${branch}-leaf", label: "Leaf", sub: "src/leaf.ts", color: "system" }],`,
    "    },",
    "  ],",
    "} satisfies Node;",
    "",
    "export const links = [",
    `  { from: "${branch}-leaf", to: "${linkTo}-leaf", label: "calls" },`,
    "] satisfies readonly Link[];",
    "",
  ].join("\n");

const MAP = [
  'import type { AtlasMap } from "./atlas.d.ts";',
  'import { links as coreLinks, node as core } from "./parts/core.ts";',
  'import { links as edgeLinks, node as edge } from "./parts/edge.ts";',
  "",
  "export default {",
  '  root: { title: "Parts", children: [core, edge] },',
  "  links: [...coreLinks, ...edgeLinks],",
  "} satisfies AtlasMap;",
  "",
].join("\n");

let made = 0;

function partsMap(): string {
  made += 1;
  const dir = join(TMP, `map-${made}`);

  expect(cli("new", dir).code).toBe(0);
  mkdirSync(join(dir, "parts"));
  writeFileSync(join(dir, "parts", "core.ts"), part("core", "Core", "edge"));
  writeFileSync(join(dir, "parts", "edge.ts"), part("edge", "Edge", "core"));
  writeFileSync(join(dir, "map.ts"), MAP);

  return dir;
}

async function edit(file: string, from: string, to: string): Promise<void> {
  const text = await Bun.file(file).text();

  expect(text).toContain(from);
  await Bun.write(file, text.replace(from, to));
}

const TOOLS = ["tsgo: ok", "oxlint: ok", "oxfmt: ok", "atlas.d.ts: ok", "tsconfig.json: ok"];

describe("a map assembled from parts/*.ts", () => {
  test("passes check, every tool reading the parts", () => {
    const run = cli("check", partsMap());

    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout.trimEnd().split("\n").slice(1)).toEqual(TOOLS);
  });

  test("a type error in a part is reported with the part's file and line", async () => {
    const dir = partsMap();
    await edit(join(dir, "parts", "edge.ts"), 'label: "Edge"', "label: 42");
    const run = cli("check", dir);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("parts/edge.ts(5,");
    expect(run.stderr).toBe("check: tsgo failed\n");
  });

  test("a part is linted, and its format is fmt's", async () => {
    const dir = partsMap();
    const core = join(dir, "parts", "core.ts");
    await edit(core, "\nexport const node", "\nconst unused = 1;\n\nexport const node");
    await edit(join(dir, "parts", "edge.ts"), "export const node = {", "export const node =   {");
    const misformatted = cli("check", dir);

    expect(misformatted.code).toBe(1);
    expect(misformatted.stdout).toContain("parts/core.ts:3:7");
    expect(misformatted.stdout).toMatch(/oxfmt: failed\n[^]*parts\/edge\.ts/u);
    expect(misformatted.stderr).toBe("check: oxlint, oxfmt failed\n");

    await edit(core, "\nconst unused = 1;\n", "");

    expect(cli("fmt", dir).code).toBe(0);
    expect(cli("check", dir).code).toBe(0);
  });

  test(
    "serve.ts bundles the parts and rebuilds the page when one is saved",
    async () => {
      const dir = partsMap();

      const child = Bun.spawn([process.execPath, SERVE, dir], {
        stdout: "pipe",
        stderr: "ignore",
      });

      try {
        const reader = child.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        const base = new URL(new TextDecoder().decode(first.value).split("\n")[0] ?? "").origin;

        const script = async (): Promise<string> => {
          const html = await (await fetch(`${base}/atlas.html`)).text();
          const src = /<script type="module"[^>]* src="\.\/([^"]+)"/u.exec(html)?.[1];

          return src === undefined ? "" : await (await fetch(`${base}/${src}`)).text();
        };

        expect(await script()).toContain('"Core"');

        await edit(join(dir, "parts", "core.ts"), 'label: "Core"', 'label: "Kernel"');
        const deadline = Date.now() + WAIT_MS;
        let rebuilt = "";

        while (!rebuilt.includes('"Kernel"') && Date.now() < deadline) {
          await Bun.sleep(100);
          rebuilt = await script();
        }

        expect(rebuilt).toContain('"Kernel"');
      } finally {
        child.kill();
        await child.exited;
      }
    },
    WAIT_MS * 2,
  );
});
