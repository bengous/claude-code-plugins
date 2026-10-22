/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- this module IS the boundary parser of the manifests a repository holds, JSON, TOML and YAML as their parsers leave them: nothing past it sees them untyped. */
import { posix } from "node:path";

import { byText } from "./scan.ts";

// What a repository's manifests state, for `cli.ts inventory`: each file read as data, never run.

export type ManifestKind =
  | "package.json"
  | "pyproject.toml"
  | "requirements"
  | "go.mod"
  | "Cargo.toml"
  | "compose"
  | "Dockerfile"
  | "flake.nix"
  | "nix module"
  | "workflow"
  | "gitlab-ci";

type Of<K extends ManifestKind> = { readonly kind: K; readonly path: string };

export type Service = {
  readonly name: string;
  readonly image: string | null;
  readonly build: string | null;
  readonly command: string | null;
  readonly ports: readonly string[];
  readonly dependsOn: readonly string[];
};

export type Manifest =
  | (Of<"package.json"> & {
      readonly name: string | null;
      readonly scripts: Readonly<Record<string, string>>;
      readonly entries: readonly string[];
      readonly workspaces: readonly string[];
      readonly dependencies: readonly string[];
    })
  | (Of<"pyproject.toml"> & {
      readonly name: string | null;
      readonly scripts: Readonly<Record<string, string>>;
      readonly dependencies: readonly string[];
    })
  | (Of<"requirements"> & { readonly dependencies: readonly string[] })
  | (Of<"go.mod"> & {
      readonly name: string | null;
      readonly entries: readonly string[];
      readonly dependencies: readonly string[];
    })
  | (Of<"Cargo.toml"> & {
      readonly name: string | null;
      readonly entries: readonly string[];
      readonly workspaces: readonly string[];
      readonly dependencies: readonly string[];
    })
  | (Of<"compose"> & { readonly services: readonly Service[] })
  | (Of<"Dockerfile"> & {
      readonly images: readonly string[];
      readonly entries: readonly string[];
      readonly ports: readonly string[];
    })
  | (Of<"flake.nix"> & { readonly inputs: readonly string[]; readonly outputs: readonly string[] })
  | (Of<"nix module"> & {
      readonly imports: readonly string[];
      readonly services: readonly string[];
    })
  | (Of<"workflow"> & {
      readonly name: string | null;
      readonly triggers: readonly string[];
      readonly jobs: readonly string[];
    })
  | (Of<"gitlab-ci"> & { readonly stages: readonly string[]; readonly jobs: readonly string[] })
  | (Of<ManifestKind> & { readonly error: string });

/** A manifest and the environment variables it sets or reads. */
export type Stated = { readonly manifest: Manifest; readonly env: readonly string[] };

/** The repository's files, by path from its root, and their text when it can be read. */
export type Repo = {
  readonly files: ReadonlySet<string>;
  readonly read: (path: string) => string | null;
};

const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/u;

const DOCKERFILE = /^(?:Dockerfile|Containerfile)(?:\..+)?$|\.Dockerfile$/u;

const REQUIREMENTS = /^requirements(?:[-.\w]*)\.txt$/u;

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;

/** What a file is by its path alone; a `.nix` file is a module only once its text says so. */
export function kindOf(path: string): ManifestKind | "nix" | null {
  const name = posix.basename(path);

  if (WORKFLOW.test(path)) return "workflow";

  switch (name) {
    case "package.json":
    case "pyproject.toml":
    case "go.mod":
    case "Cargo.toml":
    case "flake.nix":
      return name;
    case ".gitlab-ci.yml":
      return "gitlab-ci";
  }

  if (COMPOSE.test(name)) return "compose";

  if (DOCKERFILE.test(name)) return "Dockerfile";

  if (REQUIREMENTS.test(name)) return "requirements";

  return name.endsWith(".nix") ? "nix" : null;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a manifest's table as its parser leaves it: each field is narrowed where it is read, by textOf, textsOf, keysOf or dataOf.
type Data = Readonly<Record<string, unknown>>;

const isData = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dataOf = (value: unknown): Data => (isData(value) ? value : {});

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

const textsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item: unknown) =>
        typeof item === "string" || typeof item === "number" ? [String(item)] : [],
      )
    : [];

const keysOf = (value: unknown): string[] => Object.keys(dataOf(value)).toSorted();

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].toSorted();

function textRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(dataOf(value)).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item]] : [],
    ),
  );
}

/** Every string a package.json `exports` holds, at any depth of its conditions. */
const exportTargets = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap((item: unknown) => exportTargets(item))
      : Object.values(dataOf(value)).flatMap((item) => exportTargets(item));

function packageJson(path: string, text: string): Manifest {
  const data = dataOf(JSON.parse(text));
  const bin = data["bin"];
  const workspaces = data["workspaces"];

  return {
    kind: "package.json",
    path,
    name: textOf(data["name"]),
    scripts: textRecord(data["scripts"]),
    entries: sorted([
      ...[data["main"], data["module"]].flatMap((entry) => textOf(entry) ?? []),
      ...(typeof bin === "string" ? [bin] : Object.values(textRecord(bin))),
      ...exportTargets(data["exports"]),
    ]),
    workspaces: Array.isArray(workspaces)
      ? textsOf(workspaces)
      : textsOf(dataOf(workspaces)["packages"]),
    dependencies: keysOf(data["dependencies"]),
  };
}

const REQUIREMENT_NAME = /^\s*([A-Za-z0-9][\w.-]*)/u;

const requirementName = (line: string): string[] => {
  const name = REQUIREMENT_NAME.exec(line)?.[1];

  return name === undefined ? [] : [name];
};

function pyproject(path: string, text: string): Manifest {
  const data = dataOf(Bun.TOML.parse(text));
  const project = dataOf(data["project"]);
  const poetry = dataOf(dataOf(data["tool"])["poetry"]);

  return {
    kind: "pyproject.toml",
    path,
    name: textOf(project["name"]) ?? textOf(poetry["name"]),
    scripts: { ...textRecord(poetry["scripts"]), ...textRecord(project["scripts"]) },
    dependencies: sorted([
      ...textsOf(project["dependencies"]).flatMap((line) => requirementName(line)),
      ...keysOf(poetry["dependencies"]).filter((name) => name !== "python"),
    ]),
  };
}

function requirements(path: string, text: string): Manifest {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/#.*$/u, "").trim())
    .filter((line) => line !== "" && !line.startsWith("-"));

  return {
    kind: "requirements",
    path,
    dependencies: sorted(lines.flatMap((line) => requirementName(line))),
  };
}

const GO_MAIN = /^package main\b/mu;

function goMod(path: string, text: string, repo: Repo): Manifest {
  const block = /^require\s*\(([^)]*)\)/gmu;
  const single = /^require\s+(\S+)\s+\S+/gmu;

  const required = [
    ...[...text.matchAll(block)].flatMap(([, body]) =>
      (body ?? "").split("\n").flatMap((line) => /^\s*(\S+)\s+\S+/u.exec(line)?.[1] ?? []),
    ),
    ...[...text.matchAll(single)].flatMap(([, module]) => module ?? []),
  ];

  const dir = posix.dirname(path);
  const inModule = (file: string): boolean => dir === "." || file.startsWith(`${dir}/`);

  const mains = [...repo.files].filter(
    (file) => file.endsWith(".go") && inModule(file) && GO_MAIN.test(repo.read(file) ?? ""),
  );

  return {
    kind: "go.mod",
    path,
    name: /^module\s+(\S+)/mu.exec(text)?.[1] ?? null,
    entries: sorted(mains.map((file) => posix.dirname(file))),
    dependencies: sorted(required.filter((module) => module !== "//")),
  };
}

function cargoToml(path: string, text: string, repo: Repo): Manifest {
  const data = dataOf(Bun.TOML.parse(text));
  const dir = posix.dirname(path);
  const main = posix.join(dir, "src", "main.rs");

  const bins = (Array.isArray(data["bin"]) ? data["bin"] : []).flatMap((bin: unknown) => {
    const target = dataOf(bin);

    return textOf(target["path"]) ?? textOf(target["name"]) ?? [];
  });

  return {
    kind: "Cargo.toml",
    path,
    name: textOf(dataOf(data["package"])["name"]),
    entries: sorted([...bins, ...(repo.files.has(main) ? [main] : [])]),
    workspaces: textsOf(dataOf(data["workspace"])["members"]),
    dependencies: keysOf(data["dependencies"]),
  };
}

const INTERPOLATED = /\$\{([A-Za-z_]\w*)/gu;

const commandOf = (value: unknown): string | null =>
  Array.isArray(value) ? textsOf(value).join(" ") : textOf(value);

function environmentOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return textsOf(value).flatMap((pair) => /^([A-Za-z_]\w*)/u.exec(pair)?.[1] ?? []);
  }

  return keysOf(value);
}

function compose(path: string, text: string): Stated {
  const services = Object.entries(dataOf(dataOf(Bun.YAML.parse(text))["services"])).toSorted(
    ([a], [b]) => byText(a, b),
  );

  const env = services.flatMap(([, service]) => environmentOf(dataOf(service)["environment"]));

  return {
    manifest: {
      kind: "compose",
      path,
      services: services.map(([name, service]): Service => {
        const data = dataOf(service);
        const build = data["build"];
        const dependsOn = data["depends_on"];

        return {
          name,
          image: textOf(data["image"]),
          build: textOf(build) ?? textOf(dataOf(build)["context"]),
          command: commandOf(data["command"]),
          ports: textsOf(data["ports"]),
          dependsOn: Array.isArray(dependsOn) ? textsOf(dependsOn) : keysOf(dependsOn),
        };
      }),
    },
    env: sorted([...env, ...[...text.matchAll(INTERPOLATED)].flatMap(([, name]) => name ?? [])]),
  };
}

/** A Dockerfile's instructions, one per line once its `\` continuations are joined. */
const instructionsOf = (text: string): { readonly verb: string; readonly args: string }[] =>
  text
    .replaceAll(/\\\r?\n/gu, " ")
    .split("\n")
    .flatMap((line) => {
      const [, verb, args] = /^\s*([A-Za-z]+)\s+(.*)$/u.exec(line) ?? [];

      return verb === undefined || args === undefined
        ? []
        : [{ verb: verb.toUpperCase(), args: args.trim() }];
    });

function dockerfile(path: string, text: string): Stated {
  const instructions = instructionsOf(text);
  const stages = new Set<string>();
  const images: string[] = [];

  for (const { args } of instructions.filter((i) => i.verb === "FROM")) {
    const [image, as, stage] = args.split(/\s+/u).filter((word) => !word.startsWith("--"));

    if (image !== undefined && !stages.has(image)) images.push(image);

    if (as?.toUpperCase() === "AS" && stage !== undefined) stages.add(stage);
  }

  const argsOf = (verb: string): string[] =>
    instructions.flatMap((i) => (i.verb === verb ? [i.args] : []));

  const env = [
    ...argsOf("ENV").flatMap((args) =>
      args.includes("=")
        ? [...args.matchAll(/(?:^|\s)([A-Za-z_]\w*)=/gu)].flatMap(([, name]) => name ?? [])
        : (/^([A-Za-z_]\w*)/u.exec(args)?.[1] ?? []),
    ),
    ...argsOf("ARG").flatMap((args) => /^([A-Za-z_]\w*)/u.exec(args)?.[1] ?? []),
  ];

  return {
    manifest: {
      kind: "Dockerfile",
      path,
      images: sorted(images),
      entries: [...argsOf("ENTRYPOINT"), ...argsOf("CMD")],
      ports: sorted(argsOf("EXPOSE").flatMap((args) => args.split(/\s+/u))),
    },
    env: sorted(env),
  };
}

const matches = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].flatMap(([, name]) => name ?? []);

const FLAKE_OUTPUTS =
  /\b(nixosConfigurations|darwinConfigurations|homeConfigurations|nixosModules|homeManagerModules|packages|devShells|apps|overlays|checks|formatter|templates)\b/gu;

const CONFIGURATION =
  /\b(?:nixos|darwin|home)Configurations\.("[^"]+"|[\w-]+)|\b([\w-]+)\s*=\s*[\w.]*(?:nixosSystem|darwinSystem|homeManagerConfiguration)\b/gu;

function flake(path: string, text: string): Manifest {
  const configurations = [...text.matchAll(CONFIGURATION)].flatMap(([, dotted, assigned]) => {
    const name = dotted ?? assigned;

    return name === undefined ? [] : [name.replaceAll('"', "")];
  });

  return {
    kind: "flake.nix",
    path,
    inputs: sorted(matches(text, /\b([\w-]+)\.url\s*=/gu)),
    outputs: sorted([...matches(text, FLAKE_OUTPUTS), ...configurations.map((c) => `config ${c}`)]),
  };
}

const NIX_MODULE = /^(?:\s*#[^\n]*\n)*\s*\{[^}]*\b(?:config|lib|pkgs)\b[^}]*\}\s*:/u;

const NIX_SERVICES =
  /\bservices\.([\w-]+)\.enable\s*=\s*true|\bservices\.([\w-]+)\s*=\s*\{\s*enable\s*=\s*true|\bsystemd\.services\.([\w-]+)|\boci-containers\.containers\.([\w-]+)/gu;

function nixModule(path: string, text: string): Manifest | null {
  if (!NIX_MODULE.test(text)) return null;
  const dir = posix.dirname(path);

  const imports = [...text.matchAll(/\bimports\s*=\s*\[([^\]]*)\]/gu)].flatMap(([, list]) =>
    (list ?? "")
      .split(/\s+/u)
      .filter((word) => word.startsWith("./") || word.startsWith("../"))
      .map((word) => posix.normalize(posix.join(dir, word))),
  );

  const services = [...text.matchAll(NIX_SERVICES)].flatMap(
    ([, a, b, c, d]) => a ?? b ?? c ?? d ?? [],
  );

  return {
    kind: "nix module",
    path,
    imports: sorted(imports.filter((target) => !target.startsWith(".."))),
    services: sorted(services),
  };
}

function workflow(path: string, text: string): Manifest {
  const data = dataOf(Bun.YAML.parse(text));
  // YAML 1.1 readers turn the key `on` into true; either spelling names the triggers.
  const on = data["on"] ?? data["true"];

  return {
    kind: "workflow",
    path,
    name: textOf(data["name"]),
    triggers: typeof on === "string" ? [on] : Array.isArray(on) ? textsOf(on) : keysOf(on),
    jobs: keysOf(data["jobs"]),
  };
}

const GITLAB_KEYWORDS = new Set([
  "after_script",
  "before_script",
  "cache",
  "default",
  "image",
  "include",
  "pages",
  "services",
  "stages",
  "variables",
  "workflow",
]);

function gitlabCi(path: string, text: string): Manifest {
  const data = dataOf(Bun.YAML.parse(text));

  return {
    kind: "gitlab-ci",
    path,
    stages: textsOf(data["stages"]),
    jobs: keysOf(data).filter((key) => !key.startsWith(".") && !GITLAB_KEYWORDS.has(key)),
  };
}

const plain = (manifest: Manifest | null): Stated | null =>
  manifest === null ? null : { manifest, env: [] };

function parsed(kind: ManifestKind | "nix", path: string, text: string, repo: Repo): Stated | null {
  switch (kind) {
    case "package.json":
      return plain(packageJson(path, text));
    case "pyproject.toml":
      return plain(pyproject(path, text));
    case "requirements":
      return plain(requirements(path, text));
    case "go.mod":
      return plain(goMod(path, text, repo));
    case "Cargo.toml":
      return plain(cargoToml(path, text, repo));
    case "compose":
      return compose(path, text);
    case "Dockerfile":
      return dockerfile(path, text);
    case "flake.nix":
      return plain(flake(path, text));
    case "nix":
    case "nix module":
      return plain(nixModule(path, text));
    case "workflow":
      return plain(workflow(path, text));
    case "gitlab-ci":
      return plain(gitlabCi(path, text));
  }
}

/**
 * What the manifest at `path` states, `null` for a `.nix` file that is no module. A manifest that
 * does not parse, or that the inventory does not read, states the reason instead.
 */
export function stated(
  kind: ManifestKind | "nix",
  path: string,
  text: string | { readonly unread: string },
  repo: Repo,
): Stated | null {
  const named = kind === "nix" ? "nix module" : kind;

  if (typeof text !== "string")
    return { manifest: { kind: named, path, error: text.unread }, env: [] };

  try {
    return parsed(kind, path, text, repo);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);

    return { manifest: { kind: named, path, error: reason }, env: [] };
  }
}
