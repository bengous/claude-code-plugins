import type { GhCommand } from "./argv.ts";
import { splitOption } from "./argv.ts";
import type { Word } from "./shell.ts";
import type { Classification, View } from "./walk.ts";
import { blocker, unresolved } from "./walk.ts";

/** Options of `gh workflow run`, `gh pr edit|create` and `gh issue edit` that take a value, as the next word. */
const GATED_VALUE_OPTIONS = new Set([
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "-r",
  "--ref",
  "-R",
  "--repo",
  "-b",
  "--body",
  "--body-file",
  "-t",
  "--title",
  "-B",
  "--base",
  "-H",
  "--head",
  "-a",
  "--assignee",
  "--add-assignee",
  "--remove-assignee",
  "--remove-label",
  "-m",
  "--milestone",
  "-p",
  "--project",
  "--add-project",
  "--remove-project",
  "--add-reviewer",
  "--remove-reviewer",
  "--reviewer",
  "-T",
  "--template",
  "--recover",
]);

const LABEL_OPTIONS = new Set(["--add-label", "--label", "-l"]);

/** The number a `gh pr|issue` selector names: digits, `#<n>` or a URL; null for a branch. */
function numberOf(selector: string): number | null {
  const digits =
    /^#?(\d+)$/u.exec(selector)?.[1] ??
    /\/(?:pull|issues)\/(\d+)(?:[/?#].*)?$/u.exec(selector)?.[1];

  return digits === undefined ? null : Number(digits);
}

/**
 * The door a gh command opens where profile.approvals may gate it: `gh workflow run <workflow>`, or labels added by
 * `gh pr edit`, `gh issue edit` (a pull request is an issue) or `gh pr create`; null for any other.
 */
export function gatedDoorOf(view: View, gh: GhCommand, cwd: string): Classification | null {
  const dispatch = gh.group === "workflow" && gh.action === "run";
  const edits = (gh.group === "pr" || gh.group === "issue") && gh.action === "edit";
  const creates = gh.group === "pr" && gh.action === "create";

  if (!dispatch && !edits && !creates) {
    return null;
  }

  const words = view.unwrapped.argv;
  const start = words.findIndex((word) => word.text === gh.group) + 2;
  const positionals: Word[] = [];
  const labels: Word[] = [];
  const decisive: Word[] = [];

  for (let index = start; index < words.length; index += 1) {
    const word = words[index];
    const text = word?.text ?? "";
    const [name, attached] = splitOption(text);

    if (word === undefined) {
      continue;
    }

    const value = attached === undefined ? words[index + 1] : { ...word, text: attached };

    if (LABEL_OPTIONS.has(name) && value !== undefined) {
      labels.push(value);
      index += attached === undefined ? 1 : 0;
    } else if ((name === "-R" || name === "--repo") && value !== undefined) {
      decisive.push(value);
      index += attached === undefined ? 1 : 0;
    } else if (GATED_VALUE_OPTIONS.has(name)) {
      index += attached === undefined ? 1 : 0;
    } else if (!text.startsWith("-")) {
      positionals.push(word);
    }
  }

  const [selector] = positionals;
  const numbers = positionals.map((word) => numberOf(word.text));

  if (dispatch) {
    if (selector === undefined) {
      return null;
    }

    const why = blocker(view, { directory: gh.repo === null, branch: false }, [
      ...decisive,
      selector,
    ]);

    return why === null
      ? { kind: "door", door: { kind: "dispatch", workflow: selector.text, repo: gh.repo, cwd } }
      : unresolved("dispatch", why);
  }

  if (labels.length === 0) {
    return null;
  }

  const why = blocker(view, { directory: gh.repo === null, branch: false }, [
    ...decisive,
    ...labels,
    ...positionals,
  ]);

  return why === null
    ? {
        kind: "door",
        door: {
          kind: "label",
          prs:
            creates || numbers.length === 0 || numbers.includes(null)
              ? null
              : numbers.filter((number) => number !== null),
          labels: labels.flatMap((word) => word.text.split(",").map((label) => label.trim())),
          repo: gh.repo,
          cwd,
        },
      }
    : unresolved("label", why);
}
