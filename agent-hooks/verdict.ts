export type Verdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  /** Passes; `additionalContext`, read by the agent. */
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "block"; readonly reason: string }
  | {
      readonly kind: "rewrite";
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- updatedInput is the harness's per-tool tool_input, handed back whole: the kit reads none of its fields.
      readonly updatedInput: Record<string, unknown>;
      readonly text: string;
    };

export const ALLOW: Verdict = { kind: "allow" };
