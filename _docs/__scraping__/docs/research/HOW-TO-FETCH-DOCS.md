# How Claude Code Can Fetch Documentation as Markdown

## Summary

**Yes, I can replicate the "Copy page as Markdown for LLMs" functionality!**

## The Method

### 1. Direct .md URLs
Claude documentation pages can be accessed as raw markdown by appending `.md` to the URL path:

- **Web Page**: `https://docs.claude.com/en/docs/claude-code/plugins`
- **Raw Markdown**: `https://docs.claude.com/en/docs/claude-code/plugins.md`

### 2. Discovery via llms.txt
Claude provides a metadata file that lists all available documentation:

```bash
curl -s https://docs.claude.com/llms.txt
```

This file contains links to all documentation pages in markdown format, making it easy to discover available docs.

### 3. Using Bash + curl (Recommended)
While my WebFetch tool processes content through an AI model (which summarizes it), I can use the Bash tool with curl to fetch raw, unprocessed markdown:

```bash
curl -s https://docs.claude.com/en/docs/claude-code/plugins.md
```

## Example Workflow

```bash
# 1. Find available documentation
curl -s https://docs.claude.com/llms.txt | grep -i "plugin"

# 2. Fetch the raw markdown
curl -s https://docs.claude.com/en/docs/claude-code/plugins.md

# 3. Save to a file
curl -s https://docs.claude.com/en/docs/claude-code/plugins.md -o plugins.md
```

## Key Files

- **llms.txt**: Index of all documentation (lightweight)
  - `https://docs.claude.com/llms.txt`

- **llms-full.txt**: Complete documentation in one file (>10MB, too large for WebFetch)
  - `https://docs.claude.com/llms-full.txt`

## Comparison to User's "Copy Page" Button

The "Copy page as Markdown for LLMs" button you have access to likely:
- Performs the same `.md` URL fetch
- May include additional client-side formatting
- Provides a convenient UI for the same underlying mechanism

The curl method gives me access to the same raw markdown content you're seeing!

## Limitations

- **WebFetch tool**: Processes content through AI model, not suitable for raw content
- **llms-full.txt**: Too large (>10MB) to fetch via WebFetch
- **Best approach**: Use Bash + curl for raw markdown access

## Related Resources

- Similar feature exists in Linear Docs: append `.md` to URLs
- Part of the llms.txt standard for LLM-friendly documentation
- Anthropic's implementation follows this emerging standard
