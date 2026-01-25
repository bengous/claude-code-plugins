---
description: Extract Claude Code system prompts from cli.js using AST analysis
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/extract-system-prompts.sh":*)
  - Bash(jq*:*)
  - Bash(diff*:*)
  - Read(*:*)
---

# Dump System Prompt

Extract system prompts from Claude Code's `cli.js` using Piebald-AI's AST-based extractor.

## How It Works

This command:
1. Creates an isolated temp directory
2. Installs the npm version of `@anthropic-ai/claude-code`
3. Runs `promptExtractor.js` against `cli.js` to extract prompts via AST parsing
4. Outputs structured JSON with all extracted prompts
5. Cleans up the temp directory

## Execute Extraction

Run the extraction script:

```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/extract-system-prompts.sh"
```

## Output Location

Prompts are saved to: `.claude-system-prompts/prompts-<version>.json`

## Post-Extraction

After running the script:

1. **Report the results:**
   - Version extracted
   - Number of prompts found
   - File location

2. **If previous versions exist**, show a diff summary:
   ```bash
   # Find all prompt files
   ls -la .claude-system-prompts/

   # Compare with previous version if available
   # jq '.prompts | length' on each file
   ```

3. **Show interesting prompts** (first 500 chars of main system prompt):
   ```bash
   jq -r '.prompts[0].pieces[0][:500]' .claude-system-prompts/prompts-*.json | head -20
   ```

## Optional: Convert to Markdown

If the user wants individual markdown files, create them:

```
.claude-system-prompts/markdown/
├── 01-main-system-prompt.md
├── 02-tool-bash.md
├── 03-tool-read.md
└── ...
```

Each file should contain the reconstructed prompt with interpolation placeholders shown.

## Attribution

Extraction method vendored from [Piebald-AI/tweakcc](https://github.com/Piebald-AI/tweakcc) (MIT License).
