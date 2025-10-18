# Claude Documentation Tools

> Reusable system for downloading and organizing Claude documentation in any language and category

## Quick Links

- **📖 Full Documentation**: [__scraping__/docs/README.md](./__scraping__/docs/README.md)
- **⚡ Quick Start**: [__scraping__/docs/QUICK-START.md](./__scraping__/docs/QUICK-START.md)
- **🛠️ Scripts**: [__scraping__/scripts/](./__scraping__/scripts/)

## What This Is

A complete system for downloading Claude documentation from docs.claude.com with:
- ✅ **10 languages** supported (en, de, es, fr, id, it, ja, ko, pt, ru)
- ✅ **6 categories** (claude-code, build-with-claude, api, etc.)
- ✅ **Smart organization** matching website structure
- ✅ **60+ combinations** possible

## Quick Start

```bash
# Navigate to scripts
cd __scraping__/scripts/

# Download English Claude Code documentation
./download-docs.sh -l en -c claude-code

# Output goes to ../../scraped/claude-code/en/
```

## Structure

```
claude/
├── __scraping__/       ← Tools for building/maintaining the scraper
│   ├── scripts/        ← Executable scripts
│   ├── docs/           ← Documentation
│   └── examples/       ← Sample downloads
├── scraped/            ← Downloaded documentation (gitignored)
│   ├── claude-code/    ← Claude Code docs
│   │   └── en/         ← Language-specific downloads
│   └── mcp/            ← Model Context Protocol docs
├── references/         ← External reference repositories (gitignored)
│   └── anthropic-cookbook/  ← Cloned from GitHub (independent git repo)
└── README.md           ← This file
```

## Usage Examples

```bash
cd __scraping__/scripts/

# List available options
./download-docs.sh --list-languages
./download-docs.sh --list-categories

# Download specific language + category
./download-docs.sh -l en -c claude-code
./download-docs.sh -l de -c api
./download-docs.sh -l ja -c build-with-claude

# Download all English docs
./download-docs.sh -l en
```

## Documentation

- **User Guide**: [__scraping__/docs/README.md](./__scraping__/docs/README.md)
- **Technical Details**: [__scraping__/docs/technical/](./__scraping__/docs/technical/)
- **Research Notes**: [__scraping__/docs/research/](./__scraping__/docs/research/)

## Downloaded Documentation

Downloaded files are stored in `scraped/` organized by:
- Category (e.g., `claude-code/`)
- Language (e.g., `en/`)
- Website structure (folders matching sidebar)

This folder is gitignored as it contains generated content.

## External References

The `references/` directory contains external repositories cloned for reference:

### Anthropic Cookbook
Located at: `references/anthropic-cookbook/`
- **Source**: https://github.com/anthropics/anthropic-cookbook
- **What**: Official examples, recipes, and patterns for working with Claude
- **Contents**:
  - Claude Code SDK examples
  - Tool use patterns
  - Multimodal workflows
  - Extended thinking examples
  - Fine-tuning guides
  - And much more

**Updating the cookbook:**
```bash
cd references/anthropic-cookbook
git pull
```

This is an independent git repository (gitignored by the main dotfiles repo) that you can update separately whenever Anthropic releases new examples.

## Maintenance

```bash
# Update to latest documentation
cd __scraping__/scripts/
./download-docs.sh -l en -c claude-code

# The scripts automatically:
# - Fetch fresh llms.txt
# - Scrape current navigation
# - Download latest versions
```

## For Developers

See [__scraping__/docs/technical/SUMMARY.md](./__scraping__/docs/technical/SUMMARY.md) for:
- How the scraper works
- Architecture decisions
- Implementation details
- Development history
