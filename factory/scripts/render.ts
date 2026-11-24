export type ParamName = "OWNER" | "REPO" | "ROUTINE_ID" | "BRANCH" | "CI";

/** The parameters as given, each possibly absent: `render` refuses what is missing or malformed. */
export type RawParams = { readonly [Name in ParamName]?: string | undefined };

export type TemplateFile = { readonly path: string; readonly content: string };

export type RenderResult =
  | { readonly kind: "rendered"; readonly files: readonly TemplateFile[] }
  | { readonly kind: "refused"; readonly errors: readonly string[] };

type Rule = { readonly test: (value: string) => boolean; readonly expected: string };

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/u;

const ROUTINE_ID = /^trig_[A-Za-z0-9]+$/u;

/** What `git check-ref-format --branch` refuses anywhere in a name: controls, space, `~^:?*[\`, `..`, `@{`, `//`. */
// oxlint-disable-next-line no-control-regex -- git refuses control characters in a ref name, so this pattern must match them.
const REF_FORBIDDEN = /[\u0000- \u007F~^:?*[\\]|\.\.|@\{|\/\//u;

/** A workflow's `name:` as a double-quoted YAML string holds it unchanged: no quote, backslash, line break or `$`. */
const WORKFLOW_NAME = /^[\w .,:;/()&+-]{1,100}$/u;

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/gu;

export function isLogin(value: string): boolean {
  return LOGIN.test(value);
}

export function isRepo(value: string): boolean {
  const [owner = "", name = "", ...rest] = value.split("/");

  return (
    rest.length === 0 && isLogin(owner) && REPO_NAME.test(name) && name !== "." && name !== ".."
  );
}

export function isRoutineId(value: string): boolean {
  return ROUTINE_ID.test(value);
}

/** What a branch name may hold to be written as it is into YAML and shell: letters, digits, `_`, `.`, `/`, `-`. */
const TEMPLATE_SAFE = /^[\w./-]+$/u;

/**
 * A branch name git accepts (`git check-ref-format --branch`) and the templates can hold: a name with a comma, a
 * quote, a `$` or a backquote would change the YAML list or the shell string it is written into.
 */
export function isBranch(value: string): boolean {
  if (
    value === "" ||
    value === "@" ||
    value === "HEAD" ||
    value.startsWith("-") ||
    REF_FORBIDDEN.test(value) ||
    !TEMPLATE_SAFE.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every(
      (part) =>
        part !== "" && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
    );
}

/** The name of a GitHub Actions workflow, as its `name:` line gives it. */
export function isWorkflowName(value: string): boolean {
  return WORKFLOW_NAME.test(value) && value.trim() === value;
}

const RULES: readonly (readonly [ParamName, Rule])[] = [
  ["OWNER", { test: isLogin, expected: "a GitHub login" }],
  ["REPO", { test: isRepo, expected: "owner/name" }],
  ["ROUTINE_ID", { test: isRoutineId, expected: "a trig_ id" }],
  ["BRANCH", { test: isBranch, expected: "a git branch name" }],
  ["CI", { test: isWorkflowName, expected: "the name of a workflow" }],
];

const KNOWN: ReadonlySet<string> = new Set(RULES.map(([name]) => name));

/** The known parameters the templates name. */
export function namedParams(templates: readonly TemplateFile[]): Set<ParamName> {
  const named = new Set<ParamName>();

  for (const { content } of templates) {
    for (const [, name = ""] of content.matchAll(PLACEHOLDER)) {
      const rule = RULES.find(([known]) => known === name);

      if (rule !== undefined) named.add(rule[0]);
    }
  }

  return named;
}

/**
 * Each template with every `{{NAME}}` replaced by its parameter. Refused, with every reason, when
 * a parameter the templates name is missing, a parameter given is malformed, or a template names a
 * parameter that does not exist.
 */
export function render(templates: readonly TemplateFile[], params: RawParams): RenderResult {
  const errors: string[] = [];

  for (const { path, content } of templates) {
    for (const [, name = ""] of content.matchAll(PLACEHOLDER)) {
      if (!KNOWN.has(name)) errors.push(`${path} names an unknown parameter {{${name}}}`);
    }
  }

  const named = namedParams(templates);
  const values = new Map<string, string>();

  for (const [name, rule] of RULES) {
    const value = params[name];

    if (value === undefined || value === "") {
      if (named.has(name)) errors.push(`${name} is missing`);
    } else if (rule.test(value)) {
      values.set(name, value);
    } else {
      errors.push(`${name} is not ${rule.expected}: ${JSON.stringify(value)}`);
    }
  }

  if (errors.length > 0) return { kind: "refused", errors };

  return {
    kind: "rendered",
    files: templates.map(({ path, content }) => ({
      path,
      content: content.replaceAll(PLACEHOLDER, (_, name: string) => values.get(name) ?? ""),
    })),
  };
}
