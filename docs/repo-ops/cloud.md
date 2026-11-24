# Cloud environment

A cloud session of this repository, the factory's Worker among them, runs in the claude.ai cloud environment `claude-code-plugins`. The repository declares what that environment holds; claude.ai keeps its own copy, which only the owner changes.

| What a session gets | Declared in | Reaches a session |
|---|---|---|
| Hosts it may reach, variables | `.github/factory/environment.json` | once the owner applied it to the environment on claude.ai |
| System packages, mise | `.github/factory/setup.sh` | once the owner loaded the file again in the environment's settings, under Setup script |
| Tools and their versions | `mise.toml`, locked by `mise.lock` | at each session start: `.claude/hooks/cloud-tools.sh` runs `mise install` |
| Instructions, skills, hooks, MCP servers | `CLAUDE.md`, `.claude/`, `.mcp.json` | with the clone |

Nothing of the owner's machine reaches a session: no user `CLAUDE.md`, skill, plugin or MCP server. What a session needs is committed here.

- A secret's value never enters `environment.json`: the file is public. A secret lives on the environment on claude.ai, as a network secret or a variable.
- `mise.lock` holds each tool's download URL and checksum for linux-x64, and the environment installs in locked mode: the session's GitHub proxy refuses the API calls that would resolve a version. The workstation and CI take the locked versions too. Renovate moves them in `mise.lock`; by hand, `mise lock bun lefthook shellcheck shfmt --platform linux-x64 --bump`. Claude Code stays out of the lockfile: CI pins it to the version of `vellum/types/claude-code.d.ts`, and the cloud image ships its own.
- A tool added to `mise.toml` needs its entry in `mise.lock`, or the cloud install fails and `cloud-tools.sh` says so in the session.
- `setup.sh` records its own digest in the environment. `cloud-tools.sh` compares it with the file in the clone and tells the session when the environment ran another script: the copy on claude.ai is behind, or the session runs in another environment.
- `setup.sh` always exits 0, since a failure there would keep every session from starting: after loading a new copy, read `~/.cloud-env-setup.log` in a session.
- A change to the hosts or the variables reaches claude.ai through the `cloud-environments` skill of the owner's dotfiles, which fills the environment's dialog in his browser.
