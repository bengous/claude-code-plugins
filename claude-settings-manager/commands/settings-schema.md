---
description: Extract and analyze Claude Code settings schema
allowed-tools:
  - Bash("${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager":*)
  - Bash(claude --version:*)
  - Read(*:*)
  - Write(*:*)
  - AskUserQuestion(*:*)
model: claude-opus-4-5
---

# Settings Schema Extraction

You are extracting and analyzing Claude Code's settings schema from the npm package bundle.

## Background

Claude Code's settings are validated using Zod schemas. These schemas contain `.describe()` strings that document each setting. This command extracts those descriptions from the minified cli.js bundle to:

1. Generate documentation for all available settings
2. Find undocumented settings not in the official schemastore.org schema
3. Compare schemas between versions

## Your Task

### Step 1: Determine What the User Wants

If the user hasn't specified, ask what they want to do:

```
Use AskUserQuestion:
Question: "What would you like to do with the Claude Code schema?"
Options:
- "Extract schema from current/specific version (generate docs)"
- "Compare versions (find new/removed settings)"
- "Find undocumented settings (diff against schemastore.org)"
```

### Step 2: Get Version Information

Check the current Claude Code version:

```bash
claude --version
```

If user wants a specific version, they can provide it. Otherwise use "latest".

### Step 3: Execute the Appropriate Command

**For schema extraction:**
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" schema-extract \
  --version <VERSION> \
  --output-dir <OUTPUT_DIR> \
  --format both
```

Default output directory: current directory or user-specified.

**For version comparison:**
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" schema-diff \
  --base <VERSION1> \
  --compare <VERSION2>
```

**For finding undocumented settings:**
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/settings-manager" schema-diff \
  --base schemastore \
  --compare latest
```

### Step 4: Present Results

After extraction, read and summarize the generated files:

1. **For extraction:** Show a summary of what was extracted:
   - Total describe strings found
   - Property mappings discovered
   - File locations

2. **For comparison:** Highlight:
   - New settings in the compared version
   - Removed settings
   - New describe strings

3. **For undocumented settings:** Focus on:
   - Settings in the bundle but not in schemastore.org
   - These may be internal, beta, or simply undocumented

### Step 5: Offer Follow-up Actions

After showing results, offer relevant follow-ups:

```
Use AskUserQuestion:
Question: "What would you like to do next?"
Options:
- "View the full extracted documentation"
- "Extract another version"
- "Done"
```

## Output File Reference

The schema-extract command generates:
- `claude-code-{VERSION}.schema.json` - JSON Schema with extracted properties
- `claude-code-{VERSION}-reference.md` - Markdown documentation
- `describe-strings-{VERSION}.json` - Raw extracted data

## Important Notes

- Extraction requires network access to download from npm registry
- Results are cached for 24 hours in `~/.cache/claude-settings-manager/`
- Property mappings may be incomplete due to minification (descriptions are more reliable)
- This extracts ALL `.describe()` strings, including internal tool schemas
