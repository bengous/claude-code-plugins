/** A cloud session of this repository, as the cloud sessions API lists it. */
export type CloudRow = {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly repoUrl: string;
  readonly model: string | null;
  readonly effort: string | null;
};

/** What the pane says under the list: the last action and how it ended. */
export type PullState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "pulling"; readonly id: string; readonly title: string }
  | {
      readonly kind: "opened";
      readonly id: string;
      readonly title: string;
      readonly worktree: string;
    }
  | { readonly kind: "archived"; readonly title: string };

declare module "claude-code" {
  interface PluginState {
    "cloud-pull": {
      sessions: readonly CloudRow[];
      state: PullState;
    };
  }
}
