An agent can push to `main` of a public repository, which publishes a release nobody reviewed.

**Done when** every push to `main` of a public repository is refused before it leaves the machine. Which pushes are refused and the message are the contract; where the guard runs is free.

| Situation | Expected |
|---|---|
| `git push origin main` in a public repository | refused, the message names the release flow |
| `git push origin HEAD:main` | refused |
| `git push origin main` in a private repository | allowed |
| `git push origin feature/x` | allowed: no regression |

**Not this** pushes made by the human outside Claude Code.

<details><summary>Author's leads</summary>

- The repository's visibility is in `gh repo view --json visibility`.

</details>

<sub>Written by Claude Opus 5.5</sub>
