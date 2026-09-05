# Architecture Audit

Audit a subsystem without granting the existing code any authority.

## Skills

### `/architecture-audit:greenfield-audit <path>`

Four phases, read-only, diagnostic in the chat:

1. Requirements from tests, entry points, schemas, config, and docs. No
   implementation file is opened.
2. Minimal target architecture designed from those requirements, written before
   any implementation is read.
3. Inventory of the important existing components.
4. Verdict per component: KEEP / SIMPLIFY / REPLACE / DELETE. Doubt resolves to
   SIMPLIFY or DELETE.

Manual invocation only. The editing tools are removed for the run through
`disallowed-tools`; the skill collects its questions in a final "Unknowns"
section instead of asking mid-run.

## Installation

This plugin is part of the `bengous-plugins` marketplace.

```bash
/plugin install architecture-audit@bengous-plugins
```
