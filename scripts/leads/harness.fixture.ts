/**
 * The world a leads run reaches, for the integration tests: a git checkout with a bare `origin` whose `dev` holds
 * Renovate's commits, an in-memory GitHub that serves the REST routes the pipeline calls, and fakes of npm and of the
 * network. Git runs for real, under a global config of its own that signs nothing.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { isRecord, isStringArray, stringField } from "../../agent-hooks/core/util/json.ts";
import { gitSync } from "../../tools/platform/git.ts";
import {
  type Context,
  type Fetch,
  type GitHub,
  type Json,
  type Method,
  type Proc,
  procOf,
  RENOVATE_EMAIL,
} from "./lib.ts";

export const REPO = "bengous/claude-code-plugins";

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface FakeComment {
  readonly id: number;
  readonly body: string;
  readonly author_association: string;
  readonly created_at: string;
}

export interface FakeEvent {
  readonly event: "labeled";
  readonly label: string;
  readonly created_at: string;
}

export interface FakeIssue {
  readonly number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  author_association: string;
  locked: boolean;
  readonly comments: FakeComment[];
  readonly events: FakeEvent[];
}

function issueJson(issue: FakeIssue): Json {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    author_association: issue.author_association,
    created_at: "2026-10-01T00:00:00Z",
    html_url: `https://github.com/${REPO}/issues/${issue.number}`,
  };
}

/** GitHub's REST routes the pipeline calls, held in memory; every write is logged in `writes`. */
export class FakeGitHub implements GitHub {
  readonly issues: FakeIssue[] = [];

  readonly labels = new Set<string>(["needs-human"]);

  readonly pulls = new Map<string, Json>();

  readonly writes: string[] = [];

  /** The time GitHub stamps on the events it records. */
  now = "2026-10-30T06:00:00Z";

  addIssue(fields: Partial<FakeIssue> & Pick<FakeIssue, "title" | "body">): FakeIssue {
    const issue: FakeIssue = {
      number: this.issues.length + 400,
      state: "open",
      labels: [],
      author_association: "OWNER",
      locked: false,
      comments: [],
      events: [],
      ...fields,
    };

    this.issues.push(issue);

    return issue;
  }

  issue(number: number): FakeIssue {
    const found = this.issues.find((issue) => issue.number === number);

    if (found === undefined) throw new Error(`gh api: Not Found (HTTP 404): issue ${number}`);

    return found;
  }

  private comments = 0;

  /** A comment as GitHub would record it now, by the owner unless `author` says otherwise. */
  comment(issue: FakeIssue, body: string, author = "OWNER"): void {
    this.comments += 1;
    issue.comments.push({
      id: this.comments,
      body,
      author_association: author,
      created_at: this.now,
    });
  }

  private label(issue: FakeIssue, name: string): void {
    if (issue.labels.includes(name)) return;

    issue.labels.push(name);
    issue.events.push({ event: "labeled", label: name, created_at: this.now });
  }

  call(method: Method, path: string, body?: Json): Json {
    const route = path.replace(`repos/${REPO}/`, "");
    const fields = isRecord(body) ? body : {};
    const text = (name: string) => stringField(fields, name) ?? "";

    if (method !== "GET") this.writes.push(`${method} ${route}`);

    const pulls = /^commits\/([0-9a-f]+)\/pulls$/u.exec(route);

    if (method === "GET" && pulls !== null) return this.pulls.get(pulls[1] ?? "") ?? [];

    if (method === "POST" && route === "labels") {
      if (this.labels.has(text("name"))) {
        throw new Error(
          'gh api: Validation Failed (HTTP 422) {"errors":[{"code":"already_exists"}]}',
        );
      }

      this.labels.add(text("name"));

      return { name: text("name") };
    }

    if (method === "POST" && route === "issues") {
      const labels = fields["labels"];

      const issue = this.addIssue({
        title: text("title"),
        body: text("body"),
        labels: isStringArray(labels) ? [...labels] : [],
      });

      return issueJson(issue);
    }

    const match = /^issues\/(\d+)(?:\/(comments|labels|lock)(?:\/(.+))?)?$/u.exec(route);

    if (match === null) throw new Error(`fake GitHub: no route ${method} ${route}`);

    const issue = this.issue(Number(match[1]));
    const part = match[2];

    if (method === "GET" && part === undefined) return issueJson(issue);

    if (method === "PATCH" && part === undefined) {
      issue.state = text("state") === "closed" ? "closed" : "open";

      return issueJson(issue);
    }

    if (method === "PUT" && part === "lock") {
      issue.locked = true;

      return null;
    }

    if (method === "POST" && part === "comments") {
      this.comment(issue, text("body"));

      return { body: text("body") };
    }

    if (method === "POST" && part === "labels") {
      const labels = fields["labels"];

      for (const name of isStringArray(labels) ? labels : []) this.label(issue, name);

      return issue.labels.map((name) => ({ name }));
    }

    if (method === "DELETE" && part === "labels") {
      const name = decodeURIComponent(match[3] ?? "");

      if (!issue.labels.includes(name)) throw new Error("gh api: Label does not exist (HTTP 404)");

      issue.labels = issue.labels.filter((label) => label !== name);

      return null;
    }

    throw new Error(`fake GitHub: no route ${method} ${route}`);
  }

  list(path: string): readonly Json[] {
    const [route = "", query = ""] = path.replace(`repos/${REPO}/`, "").split("?");
    const params = new URLSearchParams(query);

    if (route === "labels") return [...this.labels].map((name) => ({ name }));

    if (route === "issues") {
      const label = params.get("labels") ?? "";
      const state = params.get("state") ?? "open";

      return this.issues
        .filter(
          (issue) => issue.labels.includes(label) && (state === "all" || issue.state === state),
        )
        .map((issue) => issueJson(issue));
    }

    const match = /^issues\/(\d+)\/(comments|events)$/u.exec(route);

    if (match === null) throw new Error(`fake GitHub: no list route ${route}`);

    const issue = this.issue(Number(match[1]));

    return match[2] === "comments"
      ? issue.comments.map((comment) => ({ ...comment }))
      : issue.events.map((event) => ({ ...event, label: { name: event.label } }));
  }

  /** The writes made since the log was last read. */
  takeWrites(): string[] {
    return this.writes.splice(0);
  }
}

// ---------------------------------------------------------------------------
// npm and the network
// ---------------------------------------------------------------------------

/** npm's answer to a command, by its arguments; null answers as an npm that fails. */
export type FakeNpm = (args: readonly string[]) => string | null;

export const NO_NPM: FakeNpm = () => null;

export interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

export interface FakeNetwork {
  readonly fetch: Fetch;
  readonly calls: FetchCall[];
}

/** A network that answers `respond`'s status and body, 404 when it gives none. */
export function fakeNetwork(
  respond: (url: string) => { readonly status: number; readonly body: string } | null,
): FakeNetwork {
  const calls: FetchCall[] = [];

  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init });

      const answer = respond(url) ?? { status: 404, body: "" };

      return Promise.resolve(new Response(answer.body, { status: answer.status }));
    },
  };
}

// ---------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------

export interface CommitSpec {
  readonly files: Readonly<Record<string, string>>;
  readonly subject: string;
  readonly date: string;
  readonly renovate: boolean;
}

export interface Sandbox {
  readonly root: string;
  /** git in the checkout, as the pipeline's context runs it. */
  readonly gitProc: (args: readonly string[]) => Proc;
  /** git in the checkout, its stdout trimmed; throws on a failure. */
  git(...args: string[]): string;
  /** Commits `files` on dev and pushes dev to origin; answers the commit's sha. */
  land(spec: CommitSpec): string;
  cleanup(): void;
}

export function sandbox(): Sandbox {
  const base = mkdtempSync(join(tmpdir(), "leads-test-"));
  const home = join(base, "home");
  const root = join(base, "work");
  const origin = join(base, "origin.git");

  mkdirSync(home);
  mkdirSync(root);

  writeFileSync(
    join(home, ".gitconfig"),
    "[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = dev\n",
  );

  // A suite run from a git hook inherits the hook's GIT_* variables: they go, and git reads this config alone.
  const env = { HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };

  const gitProc = (args: readonly string[], overlay: Readonly<Record<string, string>> = {}) =>
    procOf("git", gitSync(args, { cwd: root, scrubGitEnv: true, env: { ...env, ...overlay } }));

  const git = (...args: string[]) => {
    const result = gitProc(args);

    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.err}`);

    return result.out.trim();
  };

  git("init", "--bare", "--initial-branch=dev", origin);
  git("init", "--initial-branch=dev");
  git("remote", "add", "origin", origin);

  return {
    root,
    gitProc: (args) => gitProc(args),
    git,
    land(spec) {
      for (const [path, content] of Object.entries(spec.files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }

      git("add", "--all");

      const author = spec.renovate ? `renovate[bot] <${RENOVATE_EMAIL}>` : "t <t@t>";

      const result = gitProc(["commit", "--quiet", `--author=${author}`, "-m", spec.subject], {
        GIT_AUTHOR_DATE: spec.date,
        GIT_COMMITTER_DATE: spec.date,
      });

      if (result.code !== 0) throw new Error(`git commit: ${result.err}`);

      git("push", "--quiet", "origin", "HEAD:dev");

      return git("rev-parse", "HEAD");
    },
    cleanup() {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function manifest(fields: Readonly<Record<string, Readonly<Record<string, string>>>>): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

export interface History {
  readonly zustand: string;
  readonly sdk: string;
  readonly ci: string;
  readonly pin: string;
  readonly elkjs: string;
}

/**
 * A base commit, then five of Renovate's: zustand's patch, which vellum's code imports and #409 notes; the Agent SDK's
 * patch with no notes; a workflow's update; oxfmt pinned; elkjs, which only a doc names.
 */
export function landHistory(box: Sandbox): History {
  box.land({
    renovate: false,
    date: "2026-10-01T00:00:00Z",
    subject: "chore: base",
    files: {
      "package.json": manifest({
        devDependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.311", oxfmt: "^0.73.0" },
        scripts: { fmt: "oxfmt ." },
      }),
      "vellum/package.json": manifest({ dependencies: { zustand: "5.0.15" } }),
      "vellum/src/state.ts":
        'import { create } from "zustand";\n// TODO: drop the memo until zustand fixes getServerSnapshot\nexport const useStore = create(() => ({}));\n',
      "scripts/sdk.ts":
        'import { query } from "@anthropic-ai/claude-agent-sdk";\n\nexport { query };\n',
      "atlas/package.json": manifest({ dependencies: { elkjs: "0.12.0" } }),
      "README.md": "atlas lays its diagrams out with elkjs.\n",
      ".github/workflows/ci.yml": "on: push\n",
      ".claude/github-flow.json":
        '{ "validate": ["bun ./scripts/run-gates.ts", "bun test --parallel"] }\n',
    },
  });

  return {
    zustand: box.land({
      renovate: true,
      date: "2026-10-26T20:15:03Z",
      subject: "fix(deps): update dependency zustand to v5.0.16",
      files: { "vellum/package.json": manifest({ dependencies: { zustand: "5.0.16" } }) },
    }),
    sdk: box.land({
      renovate: true,
      date: "2026-10-27T20:50:00Z",
      subject: "chore(deps): update dependency @anthropic-ai/claude-agent-sdk to v0.3.312",
      files: {
        "package.json": manifest({
          devDependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.312", oxfmt: "^0.73.0" },
          scripts: { fmt: "oxfmt ." },
        }),
      },
    }),
    ci: box.land({
      renovate: true,
      date: "2026-10-28T10:00:00Z",
      subject: "chore(deps): update actions/checkout action to v7",
      files: { ".github/workflows/ci.yml": "on: [push]\n" },
    }),
    pin: box.land({
      renovate: true,
      date: "2026-10-28T11:00:00Z",
      subject: "chore(deps): pin dependencies",
      files: {
        "package.json": manifest({
          devDependencies: { "@anthropic-ai/claude-agent-sdk": "0.3.312", oxfmt: "0.73.0" },
          scripts: { fmt: "oxfmt ." },
        }),
      },
    }),
    elkjs: box.land({
      renovate: true,
      date: "2026-10-29T15:47:31Z",
      subject: "fix(deps): update dependency elkjs to v0.12.1",
      files: { "atlas/package.json": manifest({ dependencies: { elkjs: "0.12.1" } }) },
    }),
  };
}

/** npm as the tests need it: no executables, a GitHub repository with no changelog, `typesDiff` for any `.d.ts` diff. */
export function npmWith(typesDiff: string): FakeNpm {
  return (args) => {
    if (args[0] === "view") {
      return args[2] === "repository"
        ? '{"type":"git","url":"git+https://github.com/o/r.git"}'
        : "";
    }

    if (args[0] === "diff") return args.includes("**/*.d.ts") ? typesDiff : "";

    return null;
  };
}

export interface World {
  readonly ctx: Context;
  readonly printed: string[];
  readonly warned: string[];
}

export function contextIn(
  box: Sandbox,
  gh: GitHub,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    readonly npm?: FakeNpm;
    readonly fetch?: Fetch;
  } = {},
): World {
  const printed: string[] = [];
  const warned: string[] = [];

  return {
    printed,
    warned,
    ctx: {
      root: box.root,
      repo: REPO,
      env: options.env ?? {},
      gh,
      git: box.gitProc,
      npm: options.npm ?? NO_NPM,
      fetch: options.fetch ?? fakeNetwork(() => null).fetch,
      print: (line) => printed.push(line),
      warn: (line) => warned.push(line),
    },
  };
}
