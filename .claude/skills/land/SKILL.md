---
name: land
description: Land a pull request, with the pull requests under it, or a whole stack, on dev, on the human's own word. Only the human types it.
disable-model-invocation: true
argument-hint: "<pull request or stack number>"
allowed-tools: Bash(bun ./scripts/land.ts *)
---

The human typed `/land $ARGUMENTS`. Before this reached you, agent-hooks put `land-ok` on each pull request it lands and gave you a line `agent-hooks: land-ok is on #…, put there by the human's own /land <n>.` When the label could not go on, the human saw why and this command did not run. With no such line, the hook did not run, crashed, timed out or could not read `.claude/agent-hooks.jsonc`: some labels or none went on, and one it took off may still be off.

1. Run `bun ./scripts/land.ts <n>` once, with Bash `run_in_background`, `<n>` the digits of `$ARGUMENTS` without its `#`. It waits for CI by itself: write no CI wait, label or `gh run watch` around it.
2. When its task notification arrives, report the line that starts `landed` or `land:`, with the lines under it, as they are; any other ending, its last lines. With no `agent-hooks: land-ok is on` line, say first that the hook confirmed no label: `land.ts` lands only what its tier and `land-ok` checks let through, and the human can put `land-ok` on the others on GitHub, then type `/land <n>` again.
3. Then stop: what a `land:` line names is the human's to decide. Push nothing, and run `land.ts` no second time: the human's next `/land <n>` labels again.
