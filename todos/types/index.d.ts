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

export type TodoScan = {
  readonly scannedAt: number;
  readonly root: string;
  readonly userEmail: string | null;
  readonly issueBase: string | null;
  readonly todos: readonly Todo[];
};

declare module "claude-code" {
  interface PluginState {
    todos: { scan: TodoScan | null; visible: boolean; mineOnly: boolean };
  }
}
