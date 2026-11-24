Closes #412.

**Why** `gate-pr-close.ts` let `gh pr close 12 -c ""` through, so a pull request closed with an empty comment said nothing of where its work went.

**Danger** two-way door · reach: a close the hook should let through is denied, and Claude retries it once with a comment.

**Start at** `gate-pr-close.test.ts`, the test `an empty comment is no comment`.

```diff
  comment = flag(command, "--comment", "-c")
- allow when comment is not null
+ allow when comment is not null and comment.trim() is not ""
```

**Proof**

| Situation | Before | After |
|---|---|---|
| `gh pr close 12 -c ""` | allowed | denied, the reason gives the convention |
| `gh pr close 12 -c "Landed in abc123"` | allowed | allowed |

**Checks** `bun test github-flow/scripts/gate-pr-close.test.ts`: 9 pass, 0 fail.

<sub>Written by Claude</sub>
