Closes #431.

**Why** A reader of a large move saw every directory of the tree, where only the first two levels say what moved.

**Danger** two-way door · reach: a tree diff printed without `--depth` must stay byte for byte the same, or every pull request body that holds one changes shape.

**Start at** `tree-diff.integration.test.ts`, the cases under `depth`.

```diff
  tree-diff.ts <base> [--depth <n>]
  render(node, level)
+   level == depth and node has children → one line: "<dir>/ (<n> files changed)"
    otherwise → the node, then render(child, level + 1) for each child
```

**Proof**

| Situation | Before | After |
|---|---|---|
| `--depth 2` on a move of 120 files | 134 lines | 9 lines, each deeper directory a count |
| no `--depth` | 134 lines | the same 134 lines |
| `--depth 0` | not an option | exits 2: `--depth takes a positive integer` |

**Decided**

- `--depth` counts from the repository root, not from the deepest common directory: the root is what the reader sees on GitHub.

<sub>Written by Claude</sub>
