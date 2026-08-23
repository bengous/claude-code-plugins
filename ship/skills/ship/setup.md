# Ship Setup

Create a `.shiprc.json` config file for this project. This file tells `/ship` which
working files to strip from PR branches.

Paths: this file lives in `<plugin>/skills/ship/`; its sibling phase files
`prep.md` and `merge.md` live in the same directory.

Two standing rules:

- Keep every Bash call inside the command heads SKILL.md pre-approves. No
  `; echo $?` suffix, no ad-hoc `grep`/`head` — each extra head falls outside
  the approval and triggers a permission prompt. A failing command already
  reports its exit code in the tool result.
- STOP means stop: report the stated message and end the turn. Do not read the
  backend source, run substitute git commands, or write a config the user did
  not approve.

## Gather context

Run each as one plain command, nothing appended:

- Repo root: `git rev-parse --show-toplevel`
- Top-level contents: `ls -1`
- Gitignore: `cat .gitignore 2>/dev/null`
- Existing plans/docs dirs: `ls -d plans/ docs/ notes/ drafts/ .scratch/ scratch/ 2>/dev/null`

## Flow

### 1. Analyze the project

Look at the directory structure, `.gitignore`, and common conventions. Identify
directories that likely contain working files (plans, notes, drafts, specs)
that should not end up in PRs.

### 2. Suggest patterns

Present your findings with a justification for each pattern. For example:

> I found these directories that look like working artifacts:
> - `plans/` -- development plans and design docs
> - `docs/superpowers/` -- skill/plugin documentation drafts
>
> These would be stripped from PR branches. Your source code stays untouched.

Use **AskUserQuestion** with options:
- "Accept these patterns"
- "Let me adjust"
- "Skip -- I don't need file stripping"

### 3. Create the config

Write `.shiprc.json` at the repo root:

```json
{
  "strip": {
    "patterns": ["plans/", "docs/superpowers/"]
  }
}
```

If the user chose "Skip", create the config with an empty patterns array:
```json
{
  "strip": {
    "patterns": []
  }
}
```

### 4. Confirm and continue

Tell the user the config was created and remind them to commit it -- the prep
phase requires a clean working tree. Then continue using the router's Inputs
already in context: if `pr` showed an open PR, Read `merge.md` -- same
directory as this file -- and follow it; otherwise Read `prep.md` -- same
directory as this file -- and follow it.

## Rules

- Never add source code directories to the strip patterns.
- Patterns must end with `/` (directories only).
- The config file should be committed to the repo so the whole team uses it.
