# Cloud environment

A cloud session of this repository, the factory's Worker among them, runs in the claude.ai cloud environment `claude-code-plugins`. The repository declares what that environment holds; claude.ai keeps its own copy, which only the owner changes.

| What a session gets | Declared in | Reaches a session |
|---|---|---|
| Hosts it may reach, variables | `.github/factory/environment.json` | once the owner applied it to the environment on claude.ai |
| System packages, mise | `.github/factory/setup.sh` | once the owner loaded the file again in the environment's settings, under Setup script |
| Tools and their versions | `.github/factory/mise.toml`, locked by the `mise.lock` beside it | at each session start: `.claude/hooks/cloud-tools.sh` runs `mise install --locked` there and links their executables into `~/.local/bin` |
| Instructions, skills, hooks, MCP servers | `CLAUDE.md`, `.claude/`, `.mcp.json` | with the clone |

Nothing of the owner's machine reaches a session: no user `CLAUDE.md`, skill, plugin or MCP server. What a session needs is committed here.

- A secret's value never enters `environment.json`: the file is public. A secret lives on the environment on claude.ai, as a network secret or a variable, and a variable the file names like one holds `<redacted>`.
- A system package a session lacks goes in `PACKAGES` of `setup.sh`.
- `.github/factory/mise.toml` names the tools of the root `mise.toml` but Claude Code, which the cloud image ships; a test of `cloud-tools.integration.test.ts` holds the two lists together. A tool added to one is added to the other, then locked: from `.github/factory/`, `mise lock bun lefthook shellcheck shfmt --platform linux-x64`, with `--bump` to move the versions.
- The lockfile holds each tool's download URL and checksum, and the install is locked: the session's GitHub proxy refuses the API calls that would resolve a version. It stays out of the repository's root: the mise action of CI installs in locked mode once it finds a lockfile there, and fails on Claude Code, which CI pins by `MISE_CLAUDE_VERSION`. So the workstation and CI still resolve `latest` themselves, and a cloud session runs the locked versions until the lockfile moves.
- `setup.sh` records its own digest in the environment. `cloud-tools.sh` compares it with the file in the clone and tells the session when the environment ran another script: the copy on claude.ai is behind, or the session runs in another environment. Any edit of `setup.sh`, a comment included, changes that digest: load the file again after it lands.
- `setup.sh` always exits 0, since a failure there would keep every session from starting: after loading a new copy, read `~/.cloud-env-setup.log` in a session.
- A change to the hosts or the variables reaches a session once the owner edited the environment on claude.ai: nothing applies `environment.json` by itself.
