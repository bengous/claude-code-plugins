# Archived: Skill Creation Tools

**Date:** 2026-03-04
**Reason:** Superseded by Anthropic's native skill-creator tooling
**Source plugin:** claude-meta-tools

## What Was Archived

- `/skill-creator` command and subcommands (`:init`, `:validate`, `:package`)
- `/skill-review` command (multi-agent consensus review)
- Bundled `skill-creator` skill (SKILL.md + scripts + references)
- Vendored scripts: `init_skill.py`, `package_skill.py`, `quick_validate.py`

## What Replaced It

Anthropic's official skill-creator (shipped in `agent-browser` plugin and available natively) now includes:
- Skill initialization, validation, and packaging (same scripts we vendored)
- Eval testing with benchmark mode and parallel eval agents
- Automatic skill description optimization
- A/B testing with comparator agents

Blog post: https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills

## What Was NOT Archived

- `/excellence-skill-creator` (software-craft plugin) - unique anti-slop methodology, no Anthropic equivalent
- `superpowers:writing-skills` (external plugin) - TDD approach to skill authoring, complementary
