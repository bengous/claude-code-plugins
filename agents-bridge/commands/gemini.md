---
description: Invoke Google Gemini CLI for cross-model collaboration
argument-hint: <prompt>
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
  - WebSearch(*:*)
---

# Gemini Bridge

Invoke Google Gemini CLI for cross-model collaboration.

## Model Discovery (CRITICAL)

Model names change frequently. **Never guess from training data.**

### Step 1: Test Default Model
```bash
# Verify CLI works with default model
GEMINI_YOLO=true timeout 30 gemini "Say hello" 2>&1 | head -20
```

### Step 2: If User Specifies a Model
When user says "use gemini X" (e.g., "gemini 3 pro"), try these naming patterns:
```bash
# Pattern: gemini-{version}-{tier}-preview
GEMINI_YOLO=true timeout 15 gemini -m gemini-3-pro-preview "hi" 2>&1 | head -10
GEMINI_YOLO=true timeout 15 gemini -m gemini-3-flash-preview "hi" 2>&1 | head -10
```

### Step 3: If Model Not Found
If you get `ModelNotFoundError`, **web search for current model names**:
```
WebSearch: "Google Gemini API model names {current_year}"
```

### Model Naming Convention
Google uses: `gemini-{major}-{tier}[-preview]`
- Tiers: `pro`, `flash`, `nano`
- Preview models have `-preview` suffix
- Examples: `gemini-3-pro-preview`, `gemini-2.0-flash`

## Usage

```
/gemini Review the authentication implementation in src/auth/
/gemini -m gemini-3-pro-preview Analyze this error: <paste>
```

## Execution Patterns

```bash
# Simple one-shot (uses default model)
gemini "prompt"

# With specific model
gemini -m gemini-3-flash-preview "prompt"

# Batch/unattended work (REQUIRED for file operations)
GEMINI_YOLO=true gemini -m MODEL "prompt"

# With timeout (recommended for agents)
GEMINI_YOLO=true timeout 120 gemini -m MODEL "prompt"
```

## Common Issues & Fixes

### 1. Model Capacity (429 Error)
```
Error: No capacity available for model gemini-3-pro-preview
```
**Fix**: Try the flash variant (`gemini-3-flash-preview`) or retry later.

### 2. File Access Blocked
```
Error: File path is ignored by configured ignore patterns
```
**Fix**: Gemini respects `.gitignore`. Either:
- Remove the path from `.gitignore` temporarily
- Copy files to a non-ignored location

### 3. Timeout on File Operations
Gemini may do extra exploration. Use explicit timeouts:
```bash
GEMINI_YOLO=true timeout 120 gemini "Read file.png and describe it briefly"
```

### 4. Interactive Prompts Block Execution
**Fix**: Always use `GEMINI_YOLO=true` for batch work.

## Configuration (env vars)

| Variable | Description |
|----------|-------------|
| `GEMINI_MODEL` | Model override (or use `-m` flag) |
| `GEMINI_SANDBOX` | Enable sandbox mode (`true`/`false`) |
| `GEMINI_YOLO` | Auto-approve all actions - **required for batch** |

## Gemini's Available Tools

Gemini CLI has these built-in tools (useful to know when crafting prompts):
- `read_file` - Read text, images, audio, PDFs
- `write_file` - Create/overwrite files
- `list_directory` - Browse filesystem
- `search_file_content` - Ripgrep-based search
- `run_shell_command` - Execute bash commands
- `web_fetch` / `google_web_search` - Web access

## When to Use

- **Code review**: Second opinion from different model
- **Image analysis**: Gemini's vision capabilities
- **Debugging**: Different perspective on errors
- **Batch file processing**: Process multiple files with `write_file`
