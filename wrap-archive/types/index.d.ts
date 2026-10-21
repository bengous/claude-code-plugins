export type Phase = "idle" | "judging" | "offering" | "quiet" | "inert";

/** The prompt that started the turn under way, and whether the person sent it from the app or a connected device. */
export type RecordedPrompt = {
  readonly text: string;
  readonly isPersons: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "wrap-archive": {
      phase: Phase;
      prompt: RecordedPrompt | null;
      isProbed: boolean;
    };
  }
}
