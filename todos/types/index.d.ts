export type Dated = {
  readonly authoredAt: number;
  readonly commit: string | null;
  readonly authorEmail: string | null;
};

/** A finding is no line of the repository: `todos-finding` recorded it in the buffer, under its id, about a path and maybe one of its lines. */
export type Todo = Dated &
  (
    | {
        readonly source: "list" | "comment";
        readonly path: string;
        readonly line: number;
        readonly marker: string;
        readonly tag: string | null;
        readonly text: string;
      }
    | {
        readonly source: "finding";
        readonly id: string;
        readonly path: string;
        readonly line: number | null;
        readonly marker: "FINDING" | "SECURITY";
        readonly tag: null;
        readonly text: string;
      }
  );

export type Finding = Extract<Todo, { readonly source: "finding" }>;

/**
 * What the band keeps of a scan: the counts, and only as many TODOs as it scrolls through, since $.state caps a value's size.
 * The findings are apart: `total` and `mineTotal` count the TODOs alone, and a record rereads the findings without the rest.
 */
export type TodoScan = {
  readonly scannedAt: number;
  readonly root: string;
  readonly issueBase: string | null;
  readonly total: number;
  readonly mineTotal: number;
  readonly todos: readonly Todo[];
  readonly mineTodos: readonly Todo[];
  readonly findings: readonly Finding[];
};

declare module "claude-code" {
  interface PluginState {
    todos: {
      scan: TodoScan | null;
      visible: boolean;
      mineOnly: boolean;
      offset: number;
      picked: readonly string[];
    };
  }
}
