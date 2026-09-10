# Repo Bootstrap Plugin

One-shot repository setup for Claude Code. Each skill runs once per repo; the day-to-day rules it installs live in that repo's `CLAUDE.md` afterwards.

These two skills come from the retired `git-tools` plugin, unchanged. A machine that still has `git-tools` installed loads them twice: run `claude plugin uninstall git-tools` first.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `linear-flow` | `/repo-bootstrap:linear-flow` | Doctrine and bootstrap for the dev-trunk/main-release fast-forward model: rulesets, CI ancestor guard, CLAUDE.md section. |
| `submodule-setup` | on request | Migrates branches to submodules with GitHub Actions sync. |

`submodule-setup` invokes itself when the request matches; `linear-flow` is manual.

## Requirements

- GitHub CLI (`gh`) authenticated with admin rights on the repo (rulesets)

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
