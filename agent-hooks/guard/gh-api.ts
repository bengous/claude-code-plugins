import path from "node:path";

import type { GhCommand, PushTarget } from "./argv.ts";
import { GRAPHQL_MERGE, GRAPHQL_REF } from "./mentions.ts";
import type { Word } from "./shell.ts";
import type { Classification, View } from "./walk.ts";
import { blocker, quote, unresolved } from "./walk.ts";

const GH_API_VALUE_OPTIONS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "-t",
  "--template",
  "--hostname",
  "--cache",
  "-p",
  "--preview",
]);

/** What a `gh api` call sends: its method, its endpoint, its fields, and whether its body comes from a file. */
type ApiCall = {
  readonly method: Word | null;
  readonly endpoint: Word | null;
  readonly fields: ReadonlyMap<string, Word>;
  /** Every field in order, a repeated one (`-f labels[]=a -f labels[]=b`) included. */
  readonly entries: readonly (readonly [string, Word])[];
  readonly bodyFromFile: boolean;
};

function apiCallOf(argv: readonly Word[]): ApiCall {
  const api = argv.findIndex((word) => word.text === "api");
  const fields = new Map<string, Word>();
  const entries: (readonly [string, Word])[] = [];
  let method: Word | null = null;
  let endpoint: Word | null = null;
  let bodyFromFile = false;

  if (api === -1) {
    return { method, endpoint, fields, entries, bodyFromFile };
  }

  for (let index = api + 1; index < argv.length; index += 1) {
    const word = argv[index];
    const text = word?.text ?? "";
    const [name = "", attached] = text.split(/=(.*)/su);
    const value = attached === undefined ? argv[index + 1] : word;

    if (word === undefined) {
      continue;
    }

    if (GH_API_VALUE_OPTIONS.has(name) && attached === undefined) {
      index += 1;
    }

    if (name === "-X" || name === "--method") {
      method = value === undefined ? null : { ...value, text: attached ?? value.text };
    } else if (["-f", "--raw-field", "-F", "--field"].includes(name) && value !== undefined) {
      const field = attached ?? value.text;
      const equals = field.indexOf("=");
      const entry = [field.slice(0, equals), { ...value, text: field.slice(equals + 1) }] as const;
      fields.set(...entry);
      entries.push(entry);
      bodyFromFile ||=
        (name === "-F" || name === "--field") && field.slice(equals + 1).startsWith("@");
    } else if (name === "--input") {
      bodyFromFile = true;
    } else if (!text.startsWith("-") && endpoint === null) {
      endpoint = word;
    }
  }

  return { method, endpoint, fields, entries, bodyFromFile };
}

const PULL_MERGE = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/u;

const BRANCH_MERGES = /^repos\/([^/]+)\/([^/]+)\/merges$/u;

const BRANCH_REF = /^repos\/([^/]+)\/([^/]+)\/git\/refs\/heads\/(.+)$/u;

const NEW_REF = /^repos\/([^/]+)\/([^/]+)\/git\/refs$/u;

const WORKFLOW_DISPATCH = /^repos\/([^/]+)\/([^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/u;

/** An endpoint that dispatches or labels in a form the guard does not read: by repository id, or another route. */
const GATED_ENDPOINT = /(?:^repositories\/|\/dispatches$|\/(?:issues|pulls)\/[^/]+(?:\/labels)?$)/u;

const ISSUE_LABELS = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/u;

const ISSUE = /^repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/u;

/** The file a workflow segment of an endpoint names: its id, its file, or its path URL-encoded. */
function workflowFile(segment: string): string {
  try {
    return path.posix.basename(decodeURIComponent(segment));
  } catch {
    return segment;
  }
}

/** `owner/name` of an endpoint, null for gh's `{owner}/{repo}`, which names the cwd's repository. */
function apiRepo(owner: string, name: string): string | null {
  return owner === "{owner}" && name === "{repo}" ? null : `${owner}/${name}`;
}

/**
 * The door a `gh api` call opens: the merge endpoint, a branch ref moved or deleted, a GraphQL mutation; where
 * `approvals` holds, a workflow dispatch and labels added to an issue or a pull request too.
 */
export function apiDoor(view: View, cwd: string, approvals: boolean): Classification | null {
  const call = apiCallOf(view.unwrapped.argv);
  const endpoint = (call.endpoint?.text ?? "").replace(/^\//u, "").replace(/[?#].*$/u, "");

  const method = (
    call.method?.text ?? (call.fields.size > 0 || call.bodyFromFile ? "POST" : "GET")
  ).toUpperCase();

  const decisive = [call.endpoint, call.method, ...call.fields.values()].filter(
    (word) => word !== null,
  );

  const pull = PULL_MERGE.exec(endpoint);
  const merges = BRANCH_MERGES.exec(endpoint);
  const ref = BRANCH_REF.exec(endpoint);
  const created = NEW_REF.exec(endpoint);

  if (call.endpoint?.expands === true) {
    return unresolved("merge", `${quote(call.endpoint.text)} is known only at run time`);
  }

  if (endpoint === "graphql") {
    const query = call.fields.get("query")?.text ?? "";
    const merging = new RegExp(GRAPHQL_MERGE.source, "u").test(query);

    if (approvals && /\b(?:addLabelsToLabelable|labelIds)\b/u.test(query)) {
      return unresolved("label", "a GraphQL mutation names its target by node id");
    }

    return merging || new RegExp(GRAPHQL_REF.source, "u").test(query)
      ? unresolved(merging ? "merge" : "push", "a GraphQL mutation names its target by node id")
      : null;
  }

  const target = (repo: string | null, targets: PushTarget[]): Classification => {
    const why = call.bodyFromFile
      ? "its body comes from a file"
      : blocker(view, { directory: repo === null, branch: false }, decisive);

    return why === null
      ? { kind: "door", door: { kind: "api-ref", targets, repo, cwd } }
      : unresolved("push", why);
  };

  if (pull !== null && method === "PUT") {
    const repo = apiRepo(pull[1] ?? "", pull[2] ?? "");
    const why = blocker(view, { directory: repo === null, branch: false }, decisive);

    const gh: GhCommand = {
      group: "pr",
      action: "merge",
      positionals: [pull[3] ?? ""],
      repo,
      flags: new Set(),
    };

    return why === null
      ? { kind: "door", door: { kind: "merge", gh, cwd } }
      : unresolved("merge", why);
  }

  if (merges !== null && method === "POST") {
    const base = call.fields.get("base")?.text ?? "";

    return target(apiRepo(merges[1] ?? "", merges[2] ?? ""), [
      { ref: base, forced: false, deleted: false },
    ]);
  }

  if (ref !== null && (method === "PATCH" || method === "DELETE")) {
    return target(apiRepo(ref[1] ?? "", ref[2] ?? ""), [
      {
        ref: ref[3] ?? "",
        forced: call.fields.get("force")?.text === "true",
        deleted: method === "DELETE",
      },
    ]);
  }

  const dispatched = approvals ? WORKFLOW_DISPATCH.exec(endpoint) : null;
  const labelled = approvals ? (ISSUE_LABELS.exec(endpoint) ?? ISSUE.exec(endpoint)) : null;

  if (dispatched !== null && method === "POST") {
    const repo = apiRepo(dispatched[1] ?? "", dispatched[2] ?? "");
    const why = blocker(view, { directory: repo === null, branch: false }, decisive);

    return why === null
      ? {
          kind: "door",
          door: { kind: "dispatch", workflow: workflowFile(dispatched[3] ?? ""), repo, cwd },
        }
      : unresolved("dispatch", why);
  }

  if (labelled !== null && method !== "GET" && method !== "DELETE") {
    const repo = apiRepo(labelled[1] ?? "", labelled[2] ?? "");
    const labels = call.entries.filter(([name]) => /^labels(?:\[\])?$/u.test(name));

    const why = call.bodyFromFile
      ? "its body comes from a file"
      : blocker(view, { directory: repo === null, branch: false }, [
          ...(call.endpoint === null ? [] : [call.endpoint]),
          ...labels.map(([, word]) => word),
        ]);

    return why === null
      ? {
          kind: "door",
          door: {
            kind: "label",
            prs: [Number(labelled[3])],
            labels: labels.map(([, word]) => word.text),
            repo,
            cwd,
          },
        }
      : unresolved("label", why);
  }

  if (approvals && method !== "GET" && GATED_ENDPOINT.test(endpoint)) {
    return unresolved(
      endpoint.endsWith("/dispatches") ? "dispatch" : "label",
      `the guard does not read the endpoint ${quote(endpoint)}`,
    );
  }

  if (created !== null && method === "POST") {
    const name = (call.fields.get("ref")?.text ?? "").replace(/^refs\/heads\//u, "");

    return target(apiRepo(created[1] ?? "", created[2] ?? ""), [
      { ref: name, forced: false, deleted: false },
    ]);
  }

  return null;
}
