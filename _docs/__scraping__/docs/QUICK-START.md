# Quick Start Guide

## TL;DR

Download Claude documentation in any language and category:

```bash
./download-docs.sh -l LANGUAGE -c CATEGORY
```

## Installation

```bash
cd /home/b3ngous/dotfiles/docs/claude-code/
chmod +x *.sh *.py
```

## Common Commands

### 1. Download English Claude Code Documentation

```bash
./download-docs.sh -l en -c claude-code
```

**Output**: `./downloaded/` with organized folders

### 2. Download German API Documentation

```bash
./download-docs.sh -l de -c api -o ./german-api
```

### 3. List Available Options

```bash
# See all 10 languages
./download-docs.sh --list-languages

# See all 6 categories  
./download-docs.sh --list-categories
```

### 4. Download Everything in English

```bash
./download-docs.sh -l en
```

**Warning**: Downloads 108 files (~multiple MB)

### 5. Quick Download (No Organization)

```bash
./download-docs.sh -l en -c claude-code --no-scrape
```

**Faster**: Skips navigation scraping, flat structure

## What Each Flag Does

| Flag | Description | Example |
|------|-------------|---------|
| `-l` | Language code | `-l en`, `-l de`, `-l ja` |
| `-c` | Category name | `-c claude-code`, `-c api` |
| `-o` | Output directory | `-o ./my-docs` |
| `--no-scrape` | Skip navigation scraping | Faster, flat structure |
| `--list-languages` | Show available languages | Discover options |
| `--list-categories` | Show available categories | Discover options |
| `-h` | Show help | Full usage info |

## Available Options

### Languages (10)
`en` `de` `es` `fr` `id` `it` `ja` `ko` `pt` `ru`

### Categories (6)
- `claude-code` - Claude Code CLI (500 files total)
- `build-with-claude` - API guides (290 files)
- `agents-and-tools` - Agent SDK (140 files)
- `about-claude` - General info (120 files)
- `test-and-evaluate` - Testing (100 files)
- `legal-center` - Legal docs (18 files)

## Examples

### Example 1: English Claude Code

```bash
./download-docs.sh -l en -c claude-code
```

Downloads 41 files to `./downloaded/` organized by categories:
- getting-started/
- build-with-claude-code/
- deployment/
- administration/
- etc.

### Example 2: Japanese Documentation

```bash
./download-docs.sh -l ja -c claude-code -o ./docs-jp
```

Downloads 41 files in Japanese to `./docs-jp/`

### Example 3: Multiple Languages

```bash
# Create multilingual docs
for lang in en de ja; do
  ./download-docs.sh -l $lang -c claude-code -o ./docs/$lang
done
```

Result:
```
docs/
├── en/  (English)
├── de/  (German)
└── ja/  (Japanese)
```

### Example 4: API Reference Only

```bash
./download-docs.sh -l en -c build-with-claude
```

Downloads only API-related documentation

## Troubleshooting

**"No files found"**
- Check language code: `./download-docs.sh --list-languages`
- Check category: `./download-docs.sh --list-categories`

**"Failed to scrape navigation"**
- Some categories don't have sidebar navigation
- Use `--no-scrape` flag

**"Permission denied"**
```bash
chmod +x *.sh *.py
```

## Advanced Usage

### Use Parser Separately

```bash
# Get file list as JSON
python3 parse-llms-txt.py -l en -c claude-code --format json

# Get just file paths
python3 parse-llms-txt.py -l en -c claude-code --format paths

# Get just URLs
python3 parse-llms-txt.py -l en -c claude-code --format urls
```

### Custom Processing

```bash
# Download and process
./download-docs.sh -l en -c claude-code
cd downloaded

# Search all docs
grep -r "authentication" .

# Convert to PDF
for file in **/*.md; do
  pandoc "$file" -o "${file%.md}.pdf"
done
```

## Output Structure

### With Organization (default)

```
downloaded/
├── .metadata.json        ← Scrape info, stats, navigation structure
├── INDEX.md
├── getting-started/
│   ├── README.md
│   ├── overview.md
│   ├── quickstart.md
│   └── common-workflows.md
├── build-with-claude-code/
│   └── [9 files]
├── deployment/
├── administration/
├── configuration/
├── reference/
└── uncategorized/
    └── [SDK files not in sidebar]
```

**Note**: `.metadata.json` contains timestamp, download stats, and navigation structure

### Without Organization (--no-scrape)

```
downloaded/
└── claude-code/
    ├── overview.md
    ├── quickstart.md
    └── [all 41 files]
```

## Files You Need

**Essential**:
- `download-docs.sh` - Main script
- `parse-llms-txt.py` - Filter parser
- `scrape-navigation.py` - Structure extractor

**Optional**:
- `README.md` - Full documentation
- `SUMMARY.md` - Project overview
- `REUSABLE-SOLUTION.md` - Technical details

## One-Liners

```bash
# English Claude Code docs
./download-docs.sh -l en -c claude-code

# German API docs
./download-docs.sh -l de -c api

# All English docs
./download-docs.sh -l en

# List languages
./download-docs.sh --list-languages

# List categories
./download-docs.sh --list-categories

# Fast flat download
./download-docs.sh -l en -c claude-code --no-scrape
```

## Full Documentation

For complete details, see:
- **README.md** - Complete user guide
- **SUMMARY.md** - Project overview
- **REUSABLE-SOLUTION.md** - Technical implementation
- **FINAL-SOLUTION.md** - Hybrid approach explanation

## Support

The scripts work with any documentation available at docs.claude.com.

As new categories or languages are added to llms.txt, they automatically become available without code changes!
