export type TodoSource = "list" | "comment";

export type Todo = {
  readonly source: TodoSource;
  readonly path: string;
  readonly line: number;
  readonly marker: string;
  readonly tag: string | null;
  readonly text: string;
  readonly authoredAt: number;
  readonly commit: string | null;
  readonly authorEmail: string | null;
};

/** What the band keeps of a scan: the counts, and only as many TODOs as it scrolls through, since $.state caps a value's size. */
export type TodoScan = {
  readonly scannedAt: number;
  readonly root: string;
  readonly issueBase: string | null;
  readonly total: number;
  readonly mineTotal: number;
  readonly todos: readonly Todo[];
  readonly mineTodos: readonly Todo[];
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
