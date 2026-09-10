# Repo Bootstrap Plugin

One-shot repository setup for Claude Code. Each skill runs once per repo; the day-to-day rules it installs live in that repo's `CLAUDE.md` afterwards.

## Skills

| Skill | Invocation | What it does |
|-------|------------|--------------|
| `linear-flow` | `/repo-bootstrap:linear-flow` | Doctrine and bootstrap for the dev-trunk/main-release fast-forward model: rulesets, CI ancestor guard, CLAUDE.md section. |
| `submodule-setup` | on request | Migrates branches to submodules with GitHub Actions sync. |

Both skills run only on an explicit call: one-shot setup is never something to trigger from a passing request, and a manual skill costs no context in the sessions that never use it.

## Requirements

- GitHub CLI (`gh`) authenticated with admin rights on the repo (rulesets)

## License

MIT

## Author

Augustin BENGOLEA (bengous@protonmail.com)
