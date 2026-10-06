import { defineRule } from "@oxlint/plugins";

import { frozenFactsIn } from "../shared/frozen-facts.ts";

const COMMENT_OPENER_LENGTH = "/*".length;

/** Ban a Claude Code version or an Actions run id in a comment: both go stale at the next release. */
export const noFrozenFactsRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow a Claude Code version or a GitHub Actions run id in a comment; state the behaviour and the command or test that checks it.",
    },
    messages: {
      frozenFact:
        "`{{fact}}` is frozen the day it was written. State the behaviour, and the command or test that checks it, instead.",
    },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          for (const fact of frozenFactsIn(comment.value)) {
            const start = comment.start + COMMENT_OPENER_LENGTH + fact.index;

            context.report({
              messageId: "frozenFact",
              data: { fact: fact.text },
              loc: {
                start: sourceCode.getLocFromIndex(start),
                end: sourceCode.getLocFromIndex(start + fact.text.length),
              },
            });
          }
        }
      },
    };
  },
});
