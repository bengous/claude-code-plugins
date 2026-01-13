# Submodule Documentation Template

Add this section to your project's README.md or CLAUDE.md:

---

## Repository Structure

This repo uses git submodules for external content:

| Directory | Repository | Purpose |
|-----------|------------|---------|
| `{{SUBMODULE_1}}/` | {{PARENT_REPO}}-{{SUBMODULE_1}} | {{DESCRIPTION_1}} |
| `{{SUBMODULE_2}}/` | {{PARENT_REPO}}-{{SUBMODULE_2}} | {{DESCRIPTION_2}} |

**Note:** Submodule repos are source of truth. Parent auto-updates SHA pointers via GitHub Actions.

### Setup After Clone

```bash
# Option 1: Clone with submodules
git clone --recurse-submodules <repo-url>

# Option 2: Initialize after clone
./scripts/setup-dev.sh
```

### Working with Submodules

1. Make changes in submodule directory
2. Commit in submodule: `cd {{SUBMODULE_1}} && git add . && git commit -m "msg"`
3. Push submodule: `git push`
4. Parent auto-updates via GitHub Action (or commit manually)

### CI/CD Note

Workflows accessing submodule content must checkout with submodules:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

---

## Template Variables

Replace before use:

| Variable | Description | Example |
|----------|-------------|---------|
| `{{PARENT_REPO}}` | Parent repository name | `myproject` |
| `{{SUBMODULE_1}}` | First submodule directory | `docs` |
| `{{SUBMODULE_2}}` | Second submodule directory | `exports` |
| `{{DESCRIPTION_1}}` | Purpose of first submodule | `External documentation` |
| `{{DESCRIPTION_2}}` | Purpose of second submodule | `Exported workflows` |
