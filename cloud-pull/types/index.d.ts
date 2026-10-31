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

/** What went wrong, said for a person: what failed, what to do, and the raw cause. */
export type Problem = {
  readonly headline: string;
  readonly fix: string;
  readonly detail: string;
};

/** The three stages an opening runs through, in order. */
export type OpenStep = "worktree" | "teleport" | "desktop";

/** A row's own state, drawn inside the row it concerns. */
export type RowState =
  | { readonly kind: "opening"; readonly step: OpenStep }
  | { readonly kind: "opened" }
  | { readonly kind: "error"; readonly action: "open" | "archive"; readonly problem: Problem };

export type RowEntry = { readonly id: string; readonly state: RowState };

/** The list as a whole: its first load, and a refresh that failed. */
export type ListState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly problem: Problem };

/** A cloud session already opened on this computer, kept across sessions so the row offers to open it again. */
export type Opened = {
  readonly at: string;
  readonly localSessionId: string;
  readonly worktree: string;
};

export type OpenedEntry = { readonly id: string; readonly opened: Opened };

declare module "claude-code" {
  interface PluginState {
    "cloud-pull": {
      sessions: readonly CloudRow[];
      list: ListState;
      rows: readonly RowEntry[];
      opened: readonly OpenedEntry[];
      repoName: string;
    };
  }
}
