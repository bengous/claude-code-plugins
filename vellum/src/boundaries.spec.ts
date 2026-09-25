import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * What `.claude/rules/` says of the tree, held by a test: the domain does no IO, the hooks
 * module imports nothing of ours but the engine registry, the page never sees the server, and
 * an extension is a folder the core reaches through three registries.
 */

/** A path as the checks below read it, `/` between its folders: `node:path` answers `\` on Windows. */
function slashed(path: string): string {
  return path.replaceAll(sep, "/");
}

const ROOT = slashed(join(import.meta.dir, ".."));

const CORE = `${ROOT}/src/core`;

const EXTENSIONS = `${ROOT}/src/extensions`;

/** The `core/page` files the extensions import today, frozen: one more is a decision to take. */
const PAGE_SURFACE = [
  "anchoring.ts",
  "api.ts",
  "composer.tsx",
  "highlights.ts",
  "kit.tsx",
  "place.ts",
  "selection.ts",
  "state.ts",
];

/** The one import of ours the hooks module loads, from `register.ts` alone. */
const ENGINE_REGISTRY = "../../extensions/engine.ts";

const HALVES = [
  { file: "page.tsx", type: "PageExtension", registry: "page.ts" },
  { file: "server.ts", type: "ServerExtension", registry: "server.ts" },
  { file: "engine.ts", type: "EngineExtension", registry: "engine.ts" },
];

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.tsx?$/u.test(entry.name) &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.") &&
        !slashed(entry.parentPath).split("/").includes("fixtures"),
    )
    .map((entry) => slashed(join(entry.parentPath, entry.name)));
}

function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"([^"]+)"/gu)].map(
    (m) => m[1] ?? "",
  );
}

/** What the file loads at run time: the transpiler drops every type-only import. */
function valueImports(file: string): string[] {
  return new Bun.Transpiler({ loader: "ts" })
    .scanImports(readFileSync(file, "utf8"))
    .map(({ path }) => path);
}

function short(path: string): string {
  return path.slice(ROOT.length + 1);
}

/** The two scripts a browser runs for what they do at module scope, the page's and the mockup frame's: one more is a decision to take. */
const BROWSER_ENTRIES = ["src/core/page/app.tsx", "src/extensions/html/frame.ts"];

/** Imports each file in a process with no `window`, and says which ones threw, and where. */
async function failingBareImports(files: readonly string[]): Promise<string[]> {
  const script = `
    const failed = [];
    for (const file of ${JSON.stringify(files)}) {
      try {
        await import(file);
      } catch (cause) {
        const frames = String(cause?.stack ?? "").split("\\n");
        const thrownAt = frames.find((frame) => /[\\\\/]src[\\\\/]/.test(frame)) ?? "";
        failed.push(file + ": " + String(cause) + " " + thrownAt.trim());
      }
    }
    console.log(JSON.stringify(failed));
  `;

  // From the plugin's root: `bun -e` reads the JSX runtime in the `tsconfig.json` of where it runs.
  const bare = Bun.spawn(["bun", "-e", script], { cwd: ROOT, stderr: "inherit" });

  // SAFETY: the script above prints one JSON array of strings, and nothing else writes to its stdout.
  const failed = JSON.parse(await new Response(bare.stdout).text()) as string[];

  return failed.map((line) => line.replaceAll(`${ROOT}/`, ""));
}

type RelativeImport = {
  readonly file: string;
  readonly specifier: string;
  readonly target: string;
};

function relativeImports(dir: string): RelativeImport[] {
  return sources(dir).flatMap((file) =>
    imports(file)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => ({
        file,
        specifier,
        target: slashed(resolve(dirname(file), specifier)),
      })),
  );
}

function offending(dir: string, forbidden: RegExp): string[] {
  return sources(dir).flatMap((file) =>
    imports(file)
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${short(file)} imports ${specifier}`),
  );
}

describe("dependency direction", () => {
  test("core/server/domain imports no runtime, no adapter, no application, no page", () => {
    expect(
      offending(
        "src/core/server/domain",
        /^(node:|bun|\.\.\/(adapters|app)|\.\.\/\.\.\/(protocol|page))/u,
      ),
    ).toEqual([]);
  });

  test("core/engine runs on claude-code and its own siblings alone; the rest reaches it as types only", () => {
    // The transpiler drops a type-only import, so `import type … from "../protocol.ts"`
    // never shows here, and a value import from anywhere but a sibling does.
    const stray = sources("src/core/engine").flatMap((file) =>
      valueImports(file)
        .filter((path) => path !== "claude-code" && !/^\.\/[a-z-]+\.ts$/u.test(path))
        .filter((path) => !(file.endsWith("/register.ts") && path === ENGINE_REGISTRY))
        .map((path) => `${short(file)} imports ${path}`),
    );

    expect(stray).toEqual([]);
  });

  test("an engine half runs on its own folder alone: the hooks module loads nothing of the server or the page", () => {
    const stray = sources("src/extensions")
      .filter((file) => file.endsWith("/engine.ts") && slashed(dirname(file)) !== EXTENSIONS)
      .flatMap((file) =>
        valueImports(file)
          .filter((path) => !/^\.\/[a-z-]+\.ts$/u.test(path))
          .map((path) => `${short(file)} imports ${path}`),
      );

    expect(stray).toEqual([]);
  });

  test("the page and its renderers never import the server side", () => {
    const forbidden = /^(node:|bun$|.*\/server\/(app|adapters)\/)/u;
    expect(offending("src/core/page", forbidden)).toEqual([]);
    expect(offending("src/extensions", /^(.*\/server\/(app|adapters)\/)/u)).toEqual([]);
  });

  test("the server, the engine and the protocol never import the page", () => {
    expect(offending("src/core", /\/page\/(?!index\.html)/u)).toEqual([]);
  });
});

describe("the page without a browser", () => {
  test("every module of the page and of the extensions imports with no window: a browser read waits for a call", async () => {
    const modules = [...sources("src/core/page"), ...sources("src/extensions")].filter(
      (file) => !BROWSER_ENTRIES.includes(short(file)),
    );

    expect(await failingBareImports(modules)).toEqual([]);
  });
});

describe("extensions", () => {
  test("an extension imports core/ and its own folder, never another extension", () => {
    const stray = relativeImports("src/extensions")
      .filter(({ file }) => slashed(dirname(file)) !== EXTENSIONS)
      .filter(({ file, target }) => {
        const own = `${EXTENSIONS}/${slashed(relative(EXTENSIONS, file)).split("/")[0] ?? ""}`;

        return !target.startsWith(`${own}/`) && !target.startsWith(`${CORE}/`);
      })
      .map(({ file, specifier }) => `${short(file)} imports ${specifier}`);

    expect(stray).toEqual([]);
  });

  test("core/ reaches the extensions through the three registries alone", () => {
    const reaching = relativeImports("src/core")
      .filter(({ target }) => target.startsWith(`${EXTENSIONS}/`))
      .map(({ file, target }) => `${short(file)} imports ${short(target)}`)
      .toSorted();

    expect(reaching).toEqual([
      "src/core/engine/register.ts imports src/extensions/engine.ts",
      "src/core/page/app.tsx imports src/extensions/page.ts",
      "src/core/server/adapters/http/serve.ts imports src/extensions/server.ts",
    ]);
  });

  test("an extension imports from core/page the frozen list alone", () => {
    const beyond = relativeImports("src/extensions")
      .filter(({ target }) => target.startsWith(`${CORE}/page/`))
      .filter(({ target }) => !PAGE_SURFACE.includes(slashed(relative(`${CORE}/page`, target))))
      .map(({ file, specifier }) => `${short(file)} imports ${specifier}`);

    expect(beyond).toEqual([]);
  });

  test("every folder holds a half; a half's id is its folder's name, and its registry names it", () => {
    const broken = readdirSync(EXTENSIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap(({ name: id }) => {
        const present = HALVES.filter(({ file }) => existsSync(join(EXTENSIONS, id, file)));

        if (present.length === 0)
          return [`src/extensions/${id} holds no page.tsx, server.ts or engine.ts`];

        return present.flatMap(({ file, type, registry }) => {
          const path = `${EXTENSIONS}/${id}/${file}`;
          const declared = new RegExp(`export const \\w+: ${type} = \\{\\s*id: "([^"]+)"`, "u");

          return [
            ...(declared.exec(readFileSync(path, "utf8"))?.[1] === id
              ? []
              : [`${short(path)} declares no \`export const …: ${type} = { id: "${id}", … }\``]),
            ...(imports(join(EXTENSIONS, registry)).includes(`./${id}/${file}`)
              ? []
              : [`${short(path)} is not named in src/extensions/${registry}`]),
          ];
        });
      });

    expect(broken).toEqual([]);
  });

  test("a page half is page.tsx: no ui.tsx anywhere", () => {
    const named = readdirSync(join(ROOT, "src"), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === "ui.tsx")
      .map((entry) => short(slashed(join(entry.parentPath, entry.name))));

    expect(named).toEqual([]);
  });
});
