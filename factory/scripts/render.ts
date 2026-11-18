export type ParamName = "OWNER" | "REPO" | "ROUTINE_ID";

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

const RULES: readonly (readonly [ParamName, Rule])[] = [
  ["OWNER", { test: isLogin, expected: "a GitHub login" }],
  ["REPO", { test: isRepo, expected: "owner/name" }],
  ["ROUTINE_ID", { test: isRoutineId, expected: "a trig_ id" }],
];

const KNOWN: ReadonlySet<string> = new Set(RULES.map(([name]) => name));

/**
 * Each template with every `{{NAME}}` replaced by its parameter. Refused, with every reason, when
 * a parameter the templates name is missing, a parameter given is malformed, or a template names a
 * parameter that does not exist.
 */
export function render(templates: readonly TemplateFile[], params: RawParams): RenderResult {
  const errors: string[] = [];
  const named = new Set<string>();

  for (const { path, content } of templates) {
    for (const [, name = ""] of content.matchAll(PLACEHOLDER)) {
      if (KNOWN.has(name)) named.add(name);
      else errors.push(`${path} names an unknown parameter {{${name}}}`);
    }
  }

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
