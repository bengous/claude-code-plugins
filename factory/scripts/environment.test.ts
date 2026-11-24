import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { declarationProblems, ENVIRONMENT, REDACTED, SETUP_SCRIPT } from "./environment.ts";
import { REPO_PREFIX, TEMPLATES_DIR } from "./templates.ts";

const TEMPLATE = readFileSync(join(TEMPLATES_DIR, REPO_PREFIX, ENVIRONMENT), "utf8");

const NETWORK = {
  access: "limited",
  allowed_hosts: ["docs.github.com", "*.example.com"],
  allow_package_managers: true,
  allow_mcp_servers: true,
};

/** A declaration's keys, each replaceable by a value a test wants refused. */
type Overrides = {
  readonly network?: {
    readonly access: string;
    readonly allowed_hosts: readonly (string | number)[];
    readonly allow_package_managers: boolean;
    readonly allow_mcp_servers: boolean;
  };
  readonly environment_variables?: Readonly<Record<string, string>>;
  readonly setup_script?: string | null;
};

function declaration(overrides: Overrides = {}): string {
  return JSON.stringify({
    network: NETWORK,
    environment_variables: { LOG_LEVEL: "debug", API_SECRET: REDACTED },
    setup_script: SETUP_SCRIPT,
    ...overrides,
  });
}

describe("declarationProblems", () => {
  test("finds none in the template, nor in a declaration with hosts, a variable and a named secret", () => {
    expect(declarationProblems(TEMPLATE)).toEqual([]);
    expect(declarationProblems(declaration())).toEqual([]);
  });

  test("refuses a value on a variable named like a secret, whatever the case, and never repeats the value", () => {
    const problems = declarationProblems(
      declaration({
        environment_variables: {
          API_SECRET: "sk-live-1234",
          NPM_TOKEN: "npm_AbC123",
          db_password: "hunter2",
          SIGNING_KEY: REDACTED,
          LOG_LEVEL: "debug",
          MAX_OUTPUT_TOKENS: "64000",
          KEYBOARD: "us",
        },
      }),
    );

    expect(problems).toEqual([
      `environment_variables.API_SECRET is named like a secret and holds a value: write ${REDACTED}`,
      `environment_variables.NPM_TOKEN is named like a secret and holds a value: write ${REDACTED}`,
      `environment_variables.db_password is named like a secret and holds a value: write ${REDACTED}`,
    ]);
  });

  test("refuses a host written as a URL, with a path, or without a dot", () => {
    const problems = declarationProblems(
      declaration({
        network: {
          ...NETWORK,
          allowed_hosts: ["https://docs.github.com", "a.com/x", "localhost", 3],
        },
      }),
    );

    expect(problems).toEqual([
      'network.allowed_hosts holds "https://docs.github.com", not a domain',
      'network.allowed_hosts holds "a.com/x", not a domain',
      'network.allowed_hosts holds "localhost", not a domain',
      "network.allowed_hosts holds 3, not a domain",
    ]);
  });

  test("refuses another setup script than the one the install writes", () => {
    expect(declarationProblems(declaration({ setup_script: "scripts/setup.sh" }))).toEqual([
      `setup_script is not ${SETUP_SCRIPT}`,
    ]);
    expect(declarationProblems(declaration({ setup_script: null }))).toEqual([
      `setup_script is not ${SETUP_SCRIPT}`,
    ]);
  });

  test("names each missing key, each unknown key and each value of the wrong kind", () => {
    const problems = declarationProblems(
      JSON.stringify({
        network: {
          access: "full",
          allowed_hosts: "docs.github.com",
          allow_package_managers: "yes",
        },
        environment_variables: { RETRIES: 3 },
        id: "env_1",
      }),
    );

    expect(problems).toEqual([
      "setup_script is missing",
      "id is not a key",
      "network.allow_mcp_servers is missing",
      "network.access is not one of limited, unrestricted",
      "network.allowed_hosts is not a list",
      "network.allow_package_managers is not true or false",
      "environment_variables.RETRIES is not a string",
    ]);
  });

  test("names a missing key once, and refuses an access level written as a list", () => {
    expect(declarationProblems(JSON.stringify({ setup_script: SETUP_SCRIPT }))).toEqual([
      "network is missing",
      "environment_variables is missing",
    ]);
    expect(
      declarationProblems(
        JSON.stringify({
          network: { ...NETWORK, access: ["limited"] },
          environment_variables: {},
          setup_script: SETUP_SCRIPT,
        }),
      ),
    ).toEqual(["network.access is not one of limited, unrestricted"]);
  });

  test("refuses a text that is not a JSON object", () => {
    expect(declarationProblems("[]")).toEqual(["not a JSON object"]);
    expect(declarationProblems("{")[0]).toStartWith("not JSON: ");
  });
});
