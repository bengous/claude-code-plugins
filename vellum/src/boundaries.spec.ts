import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * What `.claude/rules/` says of the tree, held by a test: the workshop does no IO and imports
 * nothing outside itself, the hooks module imports nothing of ours but its registry, the page
 * never sees the server, and a part is a folder of `steps/` or `formats/` each runtime reaches
 * through its own registry, `slices.ts`.
 */

/** A path as the checks below read it, `/` between its folders: `node:path` answers `\` on Windows. */
function slashed(path: string): string {
  return path.replaceAll(sep, "/");
}

const ROOT = slashed(join(import.meta.dir, ".."));

const SRC = `${ROOT}/src`;

const WORKSHOP = `${SRC}/workshop`;

const RUNTIME = `${SRC}/runtime`;

/** The folders that hold the parts, a folder each: the steps Vellum follows, the formats it reads a document in. */
const PART_GROUPS = ["steps", "formats"];

/** The one reach out of the workshop, as types: the listeners and page slots a contract names. One more is a decision to take. */
const PLUGS_READS = ["../runtime/hooks/extension.ts", "../runtime/extension.ts"];

/** The `runtime/page` files the parts import today, frozen: one more is a decision to take. */
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

/** What a part imports of a runtime's folder, and the half it must fill to import it, frozen: one more is a decision to take. */
type Surface = {
  readonly folder: string;
  readonly halves: readonly string[];
  readonly files: readonly string[];
  readonly typesOnly: boolean;
};

const SURFACES: readonly Surface[] = [
  { folder: "page", halves: ["page.tsx"], files: PAGE_SURFACE, typesOnly: false },
  { folder: "server", halves: ["server.ts"], files: ["slice.ts"], typesOnly: false },
  {
    folder: "hooks",
    halves: ["hooks.ts", "engine.ts"],
    files: ["extension.ts", "mode.ts"],
    typesOnly: true,
  },
];

/** A half's file, how it declares itself before `= { id: "<id>"` (`\w+` for any name), and the registry that names it. */
type Half = { readonly file: string; readonly declared: string; readonly registry: string };

const HALVES: readonly Half[] = [
  { file: "page.tsx", declared: "\\w+: PageExtension", registry: "page/slices.ts" },
  { file: "server.ts", declared: "\\w+: ServerExtension", registry: "server/slices.ts" },
  { file: "engine.ts", declared: "\\w+: EngineExtension", registry: "hooks/slices.ts" },
];

/** A slice's halves: a folder holding `contract.ts`, each half typed by its plugs and named as its file is. */
const SLICE_HALVES: readonly Half[] = [
  { file: "page.tsx", declared: "page: PageHalf<\\w+Plugs>", registry: "page/slices.ts" },
  { file: "server.ts", declared: "server: ServerHalf<\\w+Plugs>", registry: "server/slices.ts" },
  { file: "hooks.ts", declared: "hooks: HooksHalf<\\w+Plugs>", registry: "hooks/slices.ts" },
];

/** The three registries, one per runtime: the only files of `runtime/` that import a part. */
const REGISTRIES = ["hooks/slices.ts", "page/slices.ts", "server/slices.ts"].map(
  (registry) => `${RUNTIME}/${registry}`,
);

const CONTRACT = "contract.ts";

/** Every folder of `steps/` and `formats/`, by its path. */
function parts(): string[] {
  return PART_GROUPS.flatMap((group) =>
    readdirSync(`${SRC}/${group}`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => `${SRC}/${group}/${name}`),
  );
}

/** The parts read through their `contract.ts`. */
function slices(): string[] {
  return parts().filter((part) => existsSync(`${part}/${CONTRACT}`));
}

/** The part `file` lies in. */
function partOf(file: string): string {
  const part = parts().find((one) => file.startsWith(`${one}/`));

  if (part === undefined) throw new Error(`${file} lies in no folder of ${PART_GROUPS.join(", ")}`);

  return part;
}

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

function partSources(): string[] {
  return PART_GROUPS.flatMap((group) => sources(`src/${group}`));
}

function imports(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"([^"]+)"/gu)].map(
    (m) => m[1] ?? "",
  );
}

/** What the file loads at run time: the transpiler drops every type-only import, and reads no shebang. */
function valueImports(file: string): string[] {
  return new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" })
    .scanImports(readFileSync(file, "utf8").replace(/^#!.*\n/u, ""))
    .map(({ path }) => path);
}

/**
 * Every file `entry` loads at run time, itself included, following its relative imports; a bare
 * one is kept as written, and a file that is not a script (the page's `index.html`) is not read.
 */
function loadedBy(entry: string): string[] {
  const loaded = new Set<string>();
  const waiting = [entry];

  for (let file = waiting.pop(); file !== undefined; file = waiting.pop()) {
    if (loaded.has(file)) continue;
    loaded.add(file);

    if (!/\.tsx?$/u.test(file)) continue;

    for (const path of valueImports(file)) {
      if (path.startsWith(".")) waiting.push(slashed(resolve(dirname(file), path)));
      else loaded.add(path);
    }
  }

  return [...loaded];
}

function short(path: string): string {
  return path.slice(ROOT.length + 1);
}

/** The two scripts a browser runs for what they do at module scope, the page's and the mockup frame's: one more is a decision to take. */
const BROWSER_ENTRIES = ["src/runtime/page/app.tsx", "src/formats/html/frame.ts"];

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

function relativeImportsOf(files: readonly string[]): RelativeImport[] {
  return files.flatMap((file) =>
    imports(file)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => ({
        file,
        specifier,
        target: slashed(resolve(dirname(file), specifier)),
      })),
  );
}

function relativeImports(dir: string): RelativeImport[] {
  return relativeImportsOf(sources(dir));
}

function offending(dir: string, forbidden: RegExp): string[] {
  return sources(dir).flatMap((file) =>
    imports(file)
      .filter((specifier) => forbidden.test(specifier))
      .map((specifier) => `${short(file)} imports ${specifier}`),
  );
}

describe("dependency direction", () => {
  test("workshop/ imports nothing outside itself, no runtime, no IO, no page: plugs.ts reads the slots' names as types, the one exception", () => {
    const plugs = `${WORKSHOP}/plugs.ts`;

    const stray = sources("src/workshop").flatMap((file) =>
      imports(file)
        .filter(
          (specifier) =>
            /^(node:|bun)/u.test(specifier) ||
            (specifier.startsWith(".") &&
              !slashed(resolve(dirname(file), specifier)).startsWith(`${WORKSHOP}/`)),
        )
        .filter(
          (specifier) =>
            !(
              file === plugs &&
              PLUGS_READS.includes(specifier) &&
              !valueImports(file).includes(specifier)
            ),
        )
        .map((specifier) => `${short(file)} imports ${specifier}`),
    );

    expect(stray).toEqual([]);
  });

  test("runtime/hooks runs on claude-code and its own siblings alone; the rest reaches it as types only", () => {
    // The transpiler drops a type-only import, so `import type … from "../protocol.ts"`
    // never shows here, and a value import from anywhere but a sibling does. The registry,
    // `slices.ts`, loads the parts' hooks halves, which the tests below hold to their folders.
    const stray = sources("src/runtime/hooks")
      .filter((file) => !REGISTRIES.includes(file))
      .flatMap((file) =>
        valueImports(file)
          .filter((path) => path !== "claude-code" && !/^\.\/[a-z-]+\.ts$/u.test(path))
          .map((path) => `${short(file)} imports ${path}`),
      );

    const loadingTheRegistry = sources("src/runtime/hooks").flatMap((file) =>
      valueImports(file).includes("./slices.ts") ? [short(file)] : [],
    );

    expect(stray).toEqual([]);
    expect(loadingTheRegistry).toEqual(["src/runtime/hooks/register.ts"]);
  });

  test("an engine half runs on its own folder alone: the hooks module loads nothing of the server or the page", () => {
    const stray = parts()
      .map((part) => `${part}/engine.ts`)
      .filter((file) => existsSync(file))
      .flatMap((file) =>
        valueImports(file)
          .filter((path) => !/^\.\/[a-z-]+\.ts$/u.test(path))
          .map((path) => `${short(file)} imports ${path}`),
      );

    expect(stray).toEqual([]);
  });

  test("the page and its renderers never import the server side", () => {
    expect(offending("src/runtime/page", /^(node:|bun$)/u)).toEqual([]);

    const reaching = relativeImports("src/runtime/page")
      .filter(({ target }) => target.startsWith(`${RUNTIME}/server/`))
      .map(({ file, specifier }) => `${short(file)} imports ${specifier}`);

    expect(reaching).toEqual([]);
  });

  test("the server, the hooks module and the protocol never import the page", () => {
    const reaching = relativeImports("src/runtime")
      .filter(({ file }) => !file.startsWith(`${RUNTIME}/page/`))
      .filter(
        ({ target }) =>
          target.startsWith(`${RUNTIME}/page/`) && target !== `${RUNTIME}/page/index.html`,
      )
      .map(({ file, specifier }) => `${short(file)} imports ${specifier}`);

    expect(reaching).toEqual([]);
  });
});

describe("the page without a browser", () => {
  test("every module of the page and of the parts imports with no window: a browser read waits for a call", async () => {
    const modules = [...sources("src/runtime/page"), ...partSources()].filter(
      (file) => !BROWSER_ENTRIES.includes(short(file)),
    );

    expect(await failingBareImports(modules)).toEqual([]);
  });
});

describe("parts", () => {
  test("a part imports workshop/, runtime/ and its own folder, never another part", () => {
    const contracts = slices().map((slice) => `${slice}/${CONTRACT}`);

    const stray = relativeImportsOf(partSources())
      .filter(({ file, specifier, target }) => {
        const typed = contracts.includes(target) && !valueImports(file).includes(specifier);

        return (
          !target.startsWith(`${partOf(file)}/`) &&
          !target.startsWith(`${WORKSHOP}/`) &&
          !target.startsWith(`${RUNTIME}/`) &&
          !typed
        );
      })
      .map(({ file, specifier }) => `${short(file)} imports ${specifier}`);

    expect(stray).toEqual([]);
  });

  test("runtime/ reaches the parts through its three registries alone", () => {
    const reaching = relativeImports("src/runtime")
      .filter(({ target }) => PART_GROUPS.some((group) => target.startsWith(`${SRC}/${group}/`)))
      .map(({ file }) => short(file));

    const loadingARegistry = relativeImports("src/runtime")
      .filter(({ target }) => REGISTRIES.includes(target))
      .map(({ file, target }) => `${short(file)} imports ${short(target)}`)
      .toSorted();

    expect([...new Set(reaching)].toSorted()).toEqual(
      REGISTRIES.map((registry) => short(registry)),
    );
    expect(loadingARegistry).toEqual([
      "src/runtime/hooks/register.ts imports src/runtime/hooks/slices.ts",
      "src/runtime/page/app.tsx imports src/runtime/page/slices.ts",
      "src/runtime/server/http/serve.ts imports src/runtime/server/slices.ts",
    ]);
  });

  test("a part imports from a runtime's folder its frozen surface alone, for a half it fills", () => {
    const beyond = relativeImportsOf(partSources()).flatMap(({ file, specifier, target }) => {
      const surface = SURFACES.find(({ folder }) => target.startsWith(`${RUNTIME}/${folder}/`));

      if (surface === undefined) return [];

      const listed = surface.files.includes(
        slashed(relative(`${RUNTIME}/${surface.folder}`, target)),
      );

      const fills = surface.halves.some((half) => existsSync(`${partOf(file)}/${half}`));
      const typed = !surface.typesOnly || !valueImports(file).includes(specifier);

      return listed && fills && typed ? [] : [`${short(file)} imports ${specifier}`];
    });

    expect(beyond).toEqual([]);
  });

  test("every folder holds a half; each half carries the id its folder declares, and its registry names it", () => {
    const declaredIds = new Map<string, string[]>();

    const broken = parts().flatMap((part) => {
      const contract = `${part}/${CONTRACT}`;
      const sliced = existsSync(contract);
      const halves = sliced ? SLICE_HALVES : HALVES;
      const present = halves.filter(({ file }) => existsSync(`${part}/${file}`));

      if (present.length === 0) {
        return [`${short(part)} holds no ${halves.map(({ file }) => file).join(", ")}`];
      }

      const carried = present.map(({ file, declared }) => {
        const declaration = new RegExp(`export const ${declared} = \\{\\s*id: "([^"]+)"`, "u");

        return declaration.exec(readFileSync(`${part}/${file}`, "utf8"))?.[1];
      });

      const id = sliced
        ? /export const SLICE = defineSlice\(\{\s*id: "([^"]+)"/u.exec(
            readFileSync(contract, "utf8"),
          )?.[1]
        : carried.find((one) => one !== undefined);

      if (sliced && id === undefined) {
        return [
          `${short(contract)} declares no \`export const SLICE = defineSlice({ id: "…", … })\``,
        ];
      }

      if (id !== undefined) declaredIds.set(id, [...(declaredIds.get(id) ?? []), short(part)]);

      return present.flatMap(({ file, declared, registry }, at) => {
        const path = `${part}/${file}`;
        const wanted = `export const ${declared.replaceAll("\\w+", "…")} = { id: "${id ?? "…"}", … }`;

        const named = relativeImportsOf([`${RUNTIME}/${registry}`]).some(
          ({ target }) => target === path,
        );

        return [
          ...(id !== undefined && carried[at] === id
            ? []
            : [`${short(path)} declares no \`${wanted}\``]),
          ...(named ? [] : [`${short(path)} is not named in src/runtime/${registry}`]),
        ];
      });
    });

    const shared = [...declaredIds].flatMap(([id, folders]) =>
      folders.length > 1 ? [`${folders.join(" and ")} both declare the id ${id}`] : [],
    );

    expect([...broken, ...shared]).toEqual([]);
  });

  test("a page half is page.tsx: no ui.tsx anywhere", () => {
    const named = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name === "ui.tsx")
      .map((entry) => short(slashed(join(entry.parentPath, entry.name))));

    expect(named).toEqual([]);
  });
});

describe("slices", () => {
  test("another folder reads a slice through its contract.ts alone; a registry takes its halves", () => {
    const halfOf = new Map(
      SLICE_HALVES.map(({ file, registry }) => [`${RUNTIME}/${registry}`, file]),
    );

    const stray = slices().flatMap((slice) =>
      [...relativeImports("src"), ...relativeImports("e2e")].flatMap(({ file, target }) => {
        const reaching = target.startsWith(`${slice}/`) && !file.startsWith(`${slice}/`);
        const read = [CONTRACT, halfOf.get(file)].includes(target.slice(slice.length + 1));

        return reaching && !read
          ? [`${short(file)} imports ${short(target)}: import ${short(slice)}/${CONTRACT} instead`]
          : [];
      }),
    );

    expect(stray).toEqual([]);
  });

  test("a slice reads another slice's contract.ts as types alone: its values are that slice's server's", () => {
    const loaded = partSources().flatMap((file) =>
      valueImports(file)
        .filter((path) => path.startsWith("."))
        .map((path) => ({ file, target: slashed(resolve(dirname(file), path)) })),
    );

    const stray = slices().flatMap((slice) =>
      loaded
        .filter(
          ({ file, target }) => target === `${slice}/${CONTRACT}` && !file.startsWith(`${slice}/`),
        )
        .map(({ file }) => `${short(file)} loads ${short(slice)}/${CONTRACT}: \`import type\` it`),
    );

    expect(stray).toEqual([]);
  });

  test("a slice's hooks half loads its own folder alone, and its contract as types", () => {
    const stray = slices()
      .filter((slice) => existsSync(`${slice}/hooks.ts`))
      .flatMap((slice) =>
        loadedBy(`${slice}/hooks.ts`)
          .filter((file) => !file.startsWith(`${slice}/`) || file === `${slice}/${CONTRACT}`)
          .map(
            (file) =>
              `${short(slice)}/hooks.ts loads ${file.startsWith(`${ROOT}/`) ? short(file) : file}: the hooks module loads the slice's folder alone, and \`import type\` its ${CONTRACT}`,
          ),
      );

    expect(stray).toEqual([]);
  });

  test("the runtime never loads the proof of the table, nor a part's walk.ts: they are the tests'", () => {
    const entries = [
      "src/runtime/hooks/register.ts",
      "src/runtime/server/cli.ts",
      "src/runtime/server/preview.ts",
      ...BROWSER_ENTRIES,
    ];

    const stray = entries.flatMap((entry) =>
      loadedBy(`${ROOT}/${entry}`)
        .filter((file) => file === `${SRC}/proof.ts` || file.endsWith("/walk.ts"))
        .map((file) => `${entry} loads ${short(file)}: only a test may import it`),
    );

    expect(stray).toEqual([]);
  });

  test("a slice's page half reads its contract as types: the contract's values are the server's", () => {
    const stray = slices()
      .filter((slice) => existsSync(`${slice}/page.tsx`))
      .flatMap((slice) =>
        loadedBy(`${slice}/page.tsx`)
          .filter((file) =>
            [CONTRACT, "server.ts", "hooks.ts"].some((one) => file === `${slice}/${one}`),
          )
          .map(
            (file) =>
              `${short(slice)}/page.tsx loads ${short(file)}: the page takes what it needs as \`import type\``,
          ),
      );

    expect(stray).toEqual([]);
  });
});
