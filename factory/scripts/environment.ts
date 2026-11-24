/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters -- this module IS the boundary parser of a repository's `.github/factory/environment.json`: a file its owner and its sessions edit, read as far as the declaration goes. */

/** Where a repository declares the cloud environment its sessions run in. */
export const ENVIRONMENT = ".github/factory/environment.json";

/** The one setup script a declaration names: the file the install writes beside it. */
export const SETUP_SCRIPT = ".github/factory/setup.sh";

/** What stands for the value of a secret's variable, whose real value stays on claude.ai. */
export const REDACTED = "<redacted>";

/**
 * A variable's name that says it holds a secret: `API_SECRET`, `NPM_TOKEN`, `DB_PASSWORD`, `api_key`.
 * The word ends there: `MAX_OUTPUT_TOKENS` is a count.
 */
const SECRET_NAME = /(?:secret|token|password|passwd|credential|key)(?![a-z])/iu;

const KEYS = ["network", "environment_variables", "setup_script"] as const;

const NETWORK_KEYS = [
  "access",
  "allowed_hosts",
  "allow_package_managers",
  "allow_mcp_servers",
] as const;

const ACCESS: readonly string[] = ["limited", "unrestricted"];

/** A domain as claude.ai's allowed domains take it: no scheme, no path, an optional leading `*.`. */
const HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyProblems(value: Json, keys: readonly string[], at: string): string[] {
  const present = Object.keys(value);

  return [
    ...keys.flatMap((key) => (present.includes(key) ? [] : [`${at}${key} is missing`])),
    ...present.flatMap((key) => (keys.includes(key) ? [] : [`${at}${key} is not a key`])),
  ];
}

function networkProblems(network: unknown): string[] {
  if (!isRecord(network)) return ["network is not an object"];

  const hosts = network["allowed_hosts"];
  const access = network["access"];

  return [
    ...keyProblems(network, NETWORK_KEYS, "network."),
    ...(!("access" in network) || (typeof access === "string" && ACCESS.includes(access))
      ? []
      : [`network.access is not one of ${ACCESS.join(", ")}`]),
    ...(!("allowed_hosts" in network) || Array.isArray(hosts)
      ? (Array.isArray(hosts) ? hosts : []).flatMap((host: unknown) =>
          typeof host === "string" && HOST.test(host)
            ? []
            : [`network.allowed_hosts holds ${JSON.stringify(host)}, not a domain`],
        )
      : ["network.allowed_hosts is not a list"]),
    ...(["allow_package_managers", "allow_mcp_servers"] as const).flatMap((key) =>
      !(key in network) || typeof network[key] === "boolean"
        ? []
        : [`network.${key} is not true or false`],
    ),
  ];
}

function variableProblems(variables: unknown): string[] {
  if (!isRecord(variables)) return ["environment_variables is not an object"];

  return Object.entries(variables).flatMap(([name, value]) => {
    if (typeof value !== "string") return [`environment_variables.${name} is not a string`];

    return SECRET_NAME.test(name) && value !== REDACTED
      ? [
          `environment_variables.${name} is named like a secret and holds a value: write ${REDACTED}`,
        ]
      : [];
  });
}

/** What keeps a text from being a declaration, one line per problem; none when it is one. */
export function declarationProblems(text: string): string[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [`not JSON: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (!isRecord(parsed)) return ["not a JSON object"];

  return [
    ...keyProblems(parsed, KEYS, ""),
    ...("network" in parsed ? networkProblems(parsed["network"]) : []),
    ...("environment_variables" in parsed ? variableProblems(parsed["environment_variables"]) : []),
    ...(!("setup_script" in parsed) || parsed["setup_script"] === SETUP_SCRIPT
      ? []
      : [`setup_script is not ${SETUP_SCRIPT}`]),
  ];
}
