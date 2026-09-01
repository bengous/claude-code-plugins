# ship (archived)

Retired plugin. It merged a feature branch into `main` locally with GPG signing,
after stripping working files and opening a PR. Archived rather than deleted so the
scripts and their tests stay readable.

## Why archived

The workflow it encoded is no longer the owner's: work lands either directly on the
trunk or through a PR merged on GitHub with linear history (`/git-tools:await-merge`).
The local merge, the `-pr` branch, the `.shiprc.json` config, and the working-file
strip had no remaining user at archival time.

## Consumers updated at archival

- `.claude-plugin/marketplace.json` and the root `README.md`: the `ship` entry and row
  were removed.
