In a repository the factory set up, a cloud worker's pull request bodies do not have the shape of #588, and a contract held in an issue artifact is never judged.

**Done when**, once #588 and #589 are merged, a repository set up by `/factory:install` works as below. What a session can run after the install and what the review reads are the contract; how the files are laid out is free. Every situation below is a test a cloud session can run.

```
/factory:install ──▶ target repository: a session there runs the pr and issue skills and their check
pull request     ──▶ its body is checked against the shape of #588
review           ──▶ reads the issue body and its artifacts ──▶ judges each situation
```

| Situation | Expected |
|---|---|
| install on a fresh repository | a session there runs both skills and their check; the install reports what it added |
| install again after the repository tuned its caps | the tuned caps stay unless `--force` |
| a fixture pull request body that breaks the shape, in an installed repository | the `pr` check refuses it |
| a fixture issue whose situations sit in an HTML artifact, one of them unmet | the review names that situation as unmet |
| an issue with no artifact | the review finds the same kinds of findings as today: no regression |
| `check.ts` on a repository whose skills are missing | reports them `missing`, with the fix |
| the skills the factory installs and those of `github-flow` | cannot differ without a check failing |
| `factory/templates/claude-md-sections.md` | holds no rule on how to write a pull request body |

**Not this** the content of the two skills (#588, #589), pull request artifacts.

<details><summary>Author's leads</summary>

- `factory/scripts/install.ts repo` renders `factory/templates/repo/` and refuses to overwrite a file that differs unless `--force`.
- `factory/templates/repo/.claude/commands/pr-review.md` reads the issue with `gh issue view`; its `allowed-tools` grant no artifact route.
- `tools/platform/` and `bun ./scripts/gates/sync-platform.ts` keep copies of one source in step.
- `factory/README.md`: a template changes only after the same change has run in a trial repository.

</details>

<sub>Written by Claude Opus 5.5</sub>

