# Claude Documentation Downloader

A complete, reusable system for downloading and organizing Claude documentation with language and category filters.

## Features

✅ **Multi-language support** - Download docs in any available language (en, de, es, fr, etc.)
✅ **Category filtering** - Download specific doc sections (claude-code, api, mcp, etc.)
✅ **Smart organization** - Automatically categorizes files by website structure
✅ **Hybrid approach** - Combines HTML scraping + llms.txt for completeness
✅ **Fully automated** - Single command downloads everything organized

## Quick Start

```bash
# Download English Claude Code documentation
./download-docs.sh -l en -c claude-code

# Download German API documentation
./download-docs.sh -l de -c api

# Download all English documentation
./download-docs.sh -l en

# List available options
./download-docs.sh --list-languages
./download-docs.sh --list-categories
```

## Available Options

### Languages (10)
- `en` - English (108 files)
- `de` - German (119 files)
- `es` - Spanish (119 files)
- `fr` - French (119 files)
- `id` - Indonesian (119 files)
- `it` - Italian (119 files)
- `ja` - Japanese (119 files)
- `ko` - Korean (119 files)
- `pt` - Portuguese (119 files)
- `ru` - Russian (119 files)

### Categories (6)
- `claude-code` - Claude Code CLI tool (500 files across all languages)
- `build-with-claude` - API usage guides (290 files)
- `agents-and-tools` - Agent SDK & tools (140 files)
- `about-claude` - General info (120 files)
- `test-and-evaluate` - Testing & evaluation (100 files)
- `legal-center` - Legal docs (18 files)

## Tools

### 1. parse-llms-txt.py

Parses the llms.txt file and filters by language/category.

```bash
# List all languages
python3 parse-llms-txt.py --list-languages

# List all categories
python3 parse-llms-txt.py --list-categories

# Get English claude-code files as JSON
python3 parse-llms-txt.py -l en -c claude-code --format json

# Get just the file paths
python3 parse-llms-txt.py -l en -c claude-code --format paths

# Get just the URLs
python3 parse-llms-txt.py -l en -c claude-code --format urls

# Save to file
python3 parse-llms-txt.py -l en -c claude-code -o filtered-files.json
```

**Options:**
- `-l, --language` - Filter by language code
- `-c, --category` - Filter by category
- `--format` - Output format (json, urls, paths)
- `-o, --output` - Save to file
- `--list-languages` - Show available languages
- `--list-categories` - Show available categories

### 2. scrape-navigation.py

Scrapes the website sidebar to extract category structure.

```bash
# Scrape Claude Code navigation
python3 scrape-navigation.py

# Outputs: scraped-navigation.json
```

**Output format:**
```json
{
  "getting-started": ["overview.md", "quickstart.md", ...],
  "build-with-claude-code": ["sub-agents.md", ...],
  ...
}
```

### 3. download-docs.sh

Main download script with filters.

```bash
# Basic usage
./download-docs.sh -l LANGUAGE -c CATEGORY

# Download English Claude Code docs
./download-docs.sh -l en -c claude-code

# Download to custom directory
./download-docs.sh -l en -c claude-code -o ./my-docs

# Skip navigation scraping (faster, flat structure)
./download-docs.sh -l en -c claude-code --no-scrape

# Download all categories in English
./download-docs.sh -l en
```

**Options:**
- `-l, --language` - Language code (default: en)
- `-c, --category` - Category filter (default: all)
- `-o, --output` - Output directory (default: ./downloaded)
- `--no-scrape` - Skip navigation scraping
- `--list-languages` - List available languages
- `--list-categories` - List available categories
- `-h, --help` - Show help

## How It Works

### The Hybrid Approach

```
┌─────────────────────────────────────────────────────┐
│ Step 1: Parse llms.txt with filters                 │
│ ↓ Gets complete file list for language + category   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Step 2: Scrape navigation (optional)                │
│ ↓ Extracts category structure from website sidebar  │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Step 3: Download files via .md URLs                 │
│ ↓ Pure markdown, no HTML parsing needed             │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ Step 4: Organize by structure                       │
│ ↓ Sidebar files → categories                        │
│ ↓ Other files → uncategorized or by llms.txt cat    │
└─────────────────────────────────────────────────────┘
```

### Output Structure

**With navigation scraping:**
```
downloaded/
├── INDEX.md
├── getting-started/
│   ├── README.md
│   ├── overview.md
│   ├── quickstart.md
│   └── ...
├── build-with-claude-code/
│   └── [9 files]
├── deployment/
├── administration/
├── configuration/
├── reference/
└── uncategorized/
    └── [files not in sidebar]
```

**Without navigation scraping (--no-scrape):**
```
downloaded/
├── claude-code/
│   ├── overview.md
│   ├── quickstart.md
│   ├── setup.md
│   └── [all 41 files]
```

### Metadata Format

Each download creates a `.metadata.json` file in the output directory containing comprehensive scrape information:

```json
{
  "scrape_info": {
    "timestamp": "2025-10-10T13:18:23Z",
    "language": "en",
    "category": "claude-code",
    "source_url": "https://docs.claude.com/en/docs/claude-code/overview",
    "scraper_version": "1.1.0"
  },
  "stats": {
    "total_files": 41,
    "successful": 41,
    "failed": 0,
    "total_size": "536K"
  },
  "navigation": {
    "getting-started": ["overview.md", "quickstart.md", ...],
    "build-with-claude-code": [...],
    ...
  }
}
```

**Fields:**
- `scrape_info` - When, where, and how the docs were scraped
- `stats` - Download statistics (counts, sizes, success rate)
- `navigation` - Website navigation structure with preserved order

**Use cases:**
- Track when documentation was last updated
- Verify download completeness
- Understand category organization
- Detect stale documentation (compare timestamp with current date)

## Examples

### Example 1: Download Claude Code docs in English

```bash
./download-docs.sh -l en -c claude-code
```

Output:
- 41 files organized by website categories
- Total size: ~500 KB
- Structure matches docs.claude.com sidebar

### Example 2: Download API docs in Spanish

```bash
./download-docs.sh -l es -c build-with-claude
```

### Example 3: Download all German documentation

```bash
./download-docs.sh -l de -o ./deutsche-docs
```

### Example 4: Quick download without organization

```bash
./download-docs.sh -l en -c claude-code --no-scrape -o ./quick
```

Faster download, flat structure (no category folders).

## Comparison with Manual Method

| Aspect | Manual | Automated |
|--------|--------|-----------|
| **Languages** | English only | All 10 languages |
| **Categories** | Claude Code only | All 6 categories |
| **Reusable** | No | Yes |
| **Filters** | None | Language + category |
| **Updates** | Re-script | Re-run same command |

## Data Sources

1. **llms.txt** (`https://docs.claude.com/llms.txt`)
   - Complete file list with metadata
   - All languages and categories
   - Source of truth for available files

2. **HTML Sidebar** (via scraping)
   - Category structure
   - File organization
   - Website navigation hierarchy

3. **Direct .md URLs** (`https://docs.claude.com/{lang}/docs/{cat}/{file}.md`)
   - Pure markdown content
   - No HTML parsing needed
   - Fast downloads

## Advanced Usage

### Combine with jq for custom processing

```bash
# Get all English files across all categories
python3 parse-llms-txt.py -l en --format json | jq '.[] | .file_path'

# Count files per category
python3 parse-llms-txt.py -l en --format json | \
  jq 'group_by(.category) | map({category: .[0].category, count: length})'

# Find files with "api" in the title
python3 parse-llms-txt.py -l en --format json | \
  jq '.[] | select(.title | contains("API"))'
```

### Download multiple languages

```bash
for lang in en de es; do
  ./download-docs.sh -l $lang -c claude-code -o ./docs-$lang
done
```

### Create a multilingual documentation set

```bash
# Download English, German, and Japanese Claude Code docs
./download-docs.sh -l en -c claude-code -o ./docs/en
./download-docs.sh -l de -c claude-code -o ./docs/de
./download-docs.sh -l ja -c claude-code -o ./docs/ja
```

## Files in This Directory

| File | Purpose |
|------|---------|
| `parse-llms-txt.py` | Parse and filter llms.txt |
| `scrape-navigation.py` | Extract sidebar structure |
| `download-docs.sh` | Main download script |
| `compare-sources.sh` | Compare scraper vs llms.txt |
| `README.md` | This file |
| `FINAL-SOLUTION.md` | Technical explanation |
| `SCRAPING-SOLUTION.md` | Scraping approach details |
| `HOW-TO-FETCH-DOCS.md` | Original discovery notes |

## Maintenance

### Keep up to date

```bash
# Re-run anytime to get latest docs
./download-docs.sh -l en -c claude-code

# The scripts automatically:
# - Fetch fresh llms.txt
# - Scrape current navigation
# - Download latest file versions
```

### Verify completeness

```bash
# Compare sources
./compare-sources.sh

# Check for missing files
python3 parse-llms-txt.py -l en -c claude-code --format paths | \
  while read file; do
    [[ -f "downloaded/*/$(basename $file)" ]] || echo "Missing: $file"
  done
```

## Troubleshooting

**Problem: "No files found"**
- Check language code is valid: `./download-docs.sh --list-languages`
- Check category exists: `./download-docs.sh --list-categories`

**Problem: "Failed to scrape navigation"**
- Some categories don't have sidebar navigation
- Use `--no-scrape` flag for flat structure
- Or check if URL exists: `curl -I https://docs.claude.com/en/docs/{category}/overview`

**Problem: "403 Forbidden"**
- Scripts use proper User-Agent headers
- If blocked, wait a few minutes and retry
- Use `--no-scrape` to reduce requests

## Contributing

To add support for new categories or languages:

1. Check what's available: `./download-docs.sh --list-categories`
2. Test the filter: `python3 parse-llms-txt.py -l LANG -c CATEGORY`
3. Run the download: `./download-docs.sh -l LANG -c CATEGORY`

The scripts are automatically compatible with any new categories added to llms.txt.

---

## Model Context Protocol (MCP) Documentation Downloader

A complete system for downloading and organizing Model Context Protocol documentation with navigation-based folder structure.

### Features

✅ **3-level hierarchy** - Preserves sections → subsections → pages structure
✅ **Complete file list** - Downloads all 42 markdown files from llms.txt
✅ **Navigation structure** - Extracts and preserves website sidebar organization
✅ **Numbered folders** - Maintains navigation order with numeric prefixes
✅ **Subdirectory preservation** - Keeps nested structure to avoid overwrites
✅ **Metadata generation** - Creates comprehensive scrape information

### Quick Start

```bash
cd scripts/

# Download all MCP documentation
./download-mcp-docs.sh

# Download to custom directory
./download-mcp-docs.sh -o ./mcp-docs
```

### MCP Tools

#### 1. parse-mcp-llms.py

Parses llms.txt from modelcontextprotocol.io and extracts file metadata.

```bash
# Get all files as JSON
python3 parse-mcp-llms.py --format json

# Get just URLs
python3 parse-mcp-llms.py --format urls

# Get just paths
python3 parse-mcp-llms.py --format paths

# Save to file
python3 parse-mcp-llms.py -o mcp-files.json

# Silent mode (only output data)
python3 parse-mcp-llms.py --format json --silent
```

**Output format:**
```json
[
  {
    "title": "What is MCP?",
    "url": "https://modelcontextprotocol.io/docs/getting-started/intro",
    "path": "/docs/getting-started/intro",
    "description": "Introduction to MCP",
    "file_name": "intro.md"
  },
  ...
]
```

#### 2. scrape-mcp-navigation.py

Scrapes the MCP website sidebar to extract 3-level navigation hierarchy.

```bash
# Scrape all sections
python3 scrape-mcp-navigation.py -o navigation.json

# Scrape specific section
python3 scrape-mcp-navigation.py -s documentation -u https://modelcontextprotocol.io/docs/getting-started/intro

# Silent mode
python3 scrape-mcp-navigation.py -o navigation.json --silent
```

**Output structure:**
```json
{
  "documentation": {
    "top_level": [],
    "subsections": {
      "get-started": [
        {"title": "What is MCP?", "path": "/docs/getting-started/intro"}
      ],
      "about-mcp": [...],
      "develop-with-mcp": [...],
      "developer-tools": [...]
    }
  },
  "specification": {...},
  "community": {...},
  "about": {...}
}
```

**Sections scraped:**
- `documentation` - Getting started, learning, and development guides
- `specification` - Technical specification (versioned as 2025-06-18)
- `community` - Governance, roadmap, examples
- `about` - About MCP page

#### 3. download-mcp-docs.sh

Main orchestration script that downloads all MCP documentation with proper structure.

```bash
# Download to default location (./downloaded/mcp)
./download-mcp-docs.sh

# Download to custom directory
./download-mcp-docs.sh -o /path/to/output

# Show help
./download-mcp-docs.sh -h
```

**What it does:**
1. Scrapes navigation structure from MCP website (4 main sections)
2. Fetches complete file list from llms.txt (42 files)
3. Creates numbered folder structure matching website navigation
4. Downloads all markdown files preserving subdirectory structure
5. Generates metadata file with scrape info and navigation tree

### MCP Output Structure

```
downloaded/mcp/
├── .metadata.json
├── 01-documentation/
│   ├── develop/
│   │   ├── build-client.md
│   │   ├── build-server.md
│   │   ├── connect-local-servers.md
│   │   └── connect-remote-servers.md
│   ├── getting-started/
│   │   └── intro.md
│   ├── learn/
│   │   ├── architecture.md
│   │   ├── client-concepts.md
│   │   └── server-concepts.md
│   └── tools/
│       └── inspector.md
├── 02-specification/
│   └── 2025-06-18/
│       ├── index.md
│       ├── changelog.md
│       ├── architecture/
│       │   └── index.md
│       ├── basic/
│       │   ├── index.md
│       │   ├── lifecycle.md
│       │   ├── transports.md
│       │   ├── authorization.md
│       │   ├── security_best_practices.md
│       │   └── utilities/
│       │       ├── cancellation.md
│       │       ├── ping.md
│       │       └── progress.md
│       ├── client/
│       │   ├── roots.md
│       │   ├── sampling.md
│       │   └── elicitation.md
│       └── server/
│           ├── index.md
│           ├── prompts.md
│           ├── resources.md
│           ├── tools.md
│           └── utilities/
│               ├── completion.md
│               ├── logging.md
│               └── pagination.md
├── 03-community/
│   ├── communication.md
│   ├── clients.md
│   ├── examples.md
│   ├── governance.md
│   ├── sep-guidelines.md
│   ├── working-interest-groups.md
│   ├── antitrust.md
│   └── development/
│       └── roadmap.md
└── 04-about-mcp/
    └── index.md
```

**Key features:**
- Numbered folders (01-, 02-, 03-, 04-) preserve navigation order
- Nested subdirectories maintained to avoid file overwrites
- 5 separate `index.md` files in different directories preserved correctly

### MCP Metadata Format

```json
{
  "scrape_info": {
    "timestamp": "2025-10-10T12:27:57Z",
    "source_url": "https://modelcontextprotocol.io",
    "scraper_version": "1.0.0"
  },
  "stats": {
    "total_files": 42,
    "successful": 42,
    "failed": 0,
    "total_size": "884K"
  },
  "navigation": {
    "documentation": {...},
    "specification": {...},
    "community": {...},
    "about": {...}
  }
}
```

### MCP vs Claude Docs Comparison

| Aspect | Claude Docs | MCP Docs |
|--------|-------------|----------|
| **Languages** | 10 (en, de, es, fr, etc.) | 1 (en only) |
| **Navigation levels** | 2 (category → files) | 3 (section → subsection → files) |
| **Total files** | 1,190 (all langs) | 42 |
| **Versioned docs** | No | Yes (2025-06-18) |
| **llms.txt** | Yes | Yes |
| **Direct .md URLs** | Yes | Yes |
| **Filtering** | Language + category | None (single language) |

### MCP Statistics

- **Total files**: 42 markdown files
- **Main sections**: 4 (documentation, specification, community, about)
- **Subsections**: 11 total across all sections
- **Documentation size**: ~900 KB
- **Deepest nesting**: 4 levels (specification/2025-06-18/basic/utilities/)

### MCP Examples

**Download to current directory:**
```bash
./download-mcp-docs.sh -o ./mcp
```

**Parse llms.txt for file list:**
```bash
python3 parse-mcp-llms.py --format json > mcp-files.json
```

**Extract navigation structure:**
```bash
python3 scrape-mcp-navigation.py -o mcp-nav.json
```

**Verify download completeness:**
```bash
cd downloaded/mcp
find . -name "*.md" | wc -l  # Should show 42
```

### MCP Key Differences from Claude

1. **Simpler llms.txt format** - No language/category metadata, just title + URL + description
2. **3-level navigation** - Sections contain subsections which contain pages
3. **Versioned specification** - `/specification/2025-06-18/` prefix for all spec files
4. **Collapsible sections** - "Utilities" subsections hidden in dropdowns (captured by scraper)
5. **Subdirectory preservation required** - Multiple `index.md` files in different directories

---

## License

These scripts are tools to download publicly available documentation from docs.claude.com and modelcontextprotocol.io.
