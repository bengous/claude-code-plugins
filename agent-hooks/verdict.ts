export type Verdict =
  | { readonly kind: "allow" }
  /** Passes; `systemMessage`, shown to the user. */
  | { readonly kind: "note"; readonly text: string }
  /** Passes; `additionalContext`, read by the agent. */
  | { readonly kind: "context"; readonly text: string }
  /** The Stop's `decision: "block"`. */
  | { readonly kind: "block"; readonly reason: string }
  /** Refuses the tool call: PreToolUse's `permissionDecision: "deny"`. */
  | { readonly kind: "deny"; readonly reason: string }
  | {
      readonly kind: "rewrite";
      // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- updatedInput is the harness's per-tool tool_input, handed back whole: the kit reads none of its fields.
      readonly updatedInput: Record<string, unknown>;
      readonly text: string;
    };

export const ALLOW: Extract<Verdict, { kind: "allow" }> = { kind: "allow" };

/** The verdicts the landing guard and the commit judge give. */
export type PreBashVerdict = Extract<Verdict, { kind: "allow" | "note" | "deny" }>;
