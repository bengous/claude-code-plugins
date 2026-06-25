---
description: Capture a carry-forward summary of work done since a checkpoint so it survives a native rewind/Restore. Run before rewinding.
argument-hint: <checkpoint-message>
allowed-tools: []
model: sonnet
---

# Rewind Summary

Produce a compact, copy-ready summary of what was accomplished since a checkpoint, so the user can carry that memory back into the conversation after a native Restore wipes it.

## Why this command exists

Native rewind (`/rewind`, or double-tap Esc on an empty prompt) offers two moves that don't combine:

- **Restore** repositions to an earlier checkpoint but discards all memory of the turns after it.
- **Summarize** compresses turns in place but never repositions — it leaves you at the end.

Nothing native does both: *go back to an earlier point and keep a summary of what happened since.* This command fills that gap.

The wrinkle it must respect: the summary you write is the last message — inside the exact span a Restore throws away. It survives only if the user copies it **before** rewinding, then pastes it back as the opening of the rewound conversation. So the output is built to be copied first.

You cannot perform the rewind yourself — Restore is a manual user action. Your job is to write the note and hand over the steps.

## What to write

The user plans to rewind to this checkpoint: **"$ARGUMENTS"**

Summarize what was accomplished *after* it — the memory the rewound conversation needs to continue without redoing or relitigating anything.

If "$ARGUMENTS" is empty, summarize the session's accomplishments so far and remind the user to choose the checkpoint they'll Restore to.

### Shape (5–10 lines, hard ceiling)

Capture outcomes, not the journey:

- What was done, fixed, or decided
- Concrete artifacts: files, functions, or bugs touched; commits (relative paths only)
- Findings or constraints that would otherwise be lost
- Test/verification results (pass/fail) if any
- A final line naming the next step — this orients the rewound conversation

Keep it dense. Leave out code snippets, step-by-step narration, reasoning, and absolute paths. If it reads like a transcript or a diff, it's wrong — it's a briefing, not a replay.

## How to present it

Your visible output is exactly three things — a copy instruction, the summary block, and the steps below. Don't restate the background above.

Lead with the copy instruction, then the summary inside a plain fenced block so its boundaries are unambiguous to select (the fence is a delimiter, not code):

**Copy the block below before you rewind — it lives in the turns Restore will discard.**

```
<5–10 line carry-forward summary, ending with the next-step line>
```

Then give the user these steps:

> 1. Copy the block above now.
> 2. Run `/rewind` (or double-tap Esc on an empty prompt) and pick the checkpoint: *"$ARGUMENTS"*.
> 3. Choose **Restore conversation** (or **Restore code and conversation** to roll files back too).
> 4. Paste the block into the input and send. With *Restore conversation* the checkpoint's original prompt reappears there first — paste alongside it. The rewound conversation now opens with the memory intact.

## Example of a good summary block

```
Tracked the failing checkout flow to a race in cart-service.ts — totals
recomputed before the discount applied. Fixed by awaiting the discount
resolver; added a regression test (cart.test.ts, 4 cases, all green).
Confirmed the wishlist path doesn't share the bug.
Next: apply the same await fix to the gift-card resolver and re-run the suite.
```
