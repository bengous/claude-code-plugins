export type Phase = "idle" | "judging" | "offering" | "quiet" | "inert";

declare module "claude-code" {
  interface PluginState {
    "wrap-archive": {
      phase: Phase;
      prompt: string | null;
      isProbed: boolean;
    };
  }
}
