# Reusable Solution: Language & Category Filters

## The Enhancement

You suggested making the script more reusable by adding filters for:
1. **Language** - Download docs in any language (en, de, es, etc.)
2. **Category** - Download specific sections (claude-code, api, etc.)

This transforms the script from **single-purpose** to **multi-purpose**.

## Before vs After

### Before (Single Purpose)

```bash
# Old script - hardcoded for English Claude Code only
./fetch-claude-code-docs-organized.sh

# What it did:
- English only (hardcoded)
- Claude Code only (hardcoded)
- Not reusable for other docs
```

### After (Multi-Purpose)

```bash
# New script - flexible filters
./download-docs.sh -l en -c claude-code        # English Claude Code
./download-docs.sh -l de -c api                # German API docs
./download-docs.sh -l ja -c build-with-claude  # Japanese build guides
./download-docs.sh -l en                       # All English docs

# What it does:
- Any of 10 languages
- Any of 6 categories
- Fully reusable
```

## Implementation

### 1. Created parse-llms-txt.py

**Purpose**: Parse llms.txt with language and category filters

**Key features:**
- Extracts structured data from llms.txt
- Filters by language code
- Filters by category name
- Multiple output formats (JSON, URLs, paths)
- Lists available options

**Usage examples:**

```bash
# Discover what's available
python3 parse-llms-txt.py --list-languages
# Output:
#   • en: 108 files
#   • de: 119 files
#   • es: 119 files
#   ...

python3 parse-llms-txt.py --list-categories
# Output:
#   • claude-code: 500 files
#   • build-with-claude: 290 files
#   • api: ...

# Filter and extract
python3 parse-llms-txt.py -l en -c claude-code --format paths
# Output: List of 41 English Claude Code files

python3 parse-llms-txt.py -l de -c api -o german-api-files.json
# Output: Saves filtered data to JSON
```

### 2. Updated download-docs.sh

**Purpose**: Main download script with filter support

**Key features:**
- Accepts `-l/--language` flag
- Accepts `-c/--category` flag
- Accepts `-o/--output` for custom directory
- Lists available options
- Works with any language/category combination

**Usage examples:**

```bash
# Download specific language + category
./download-docs.sh -l es -c claude-code -o ./spanish-docs

# Download all categories in one language
./download-docs.sh -l fr -o ./french-docs

# List what's available before downloading
./download-docs.sh --list-languages
./download-docs.sh --list-categories

# Quick download without organization
./download-docs.sh -l en -c api --no-scrape
```

## How Filtering Works

### Step 1: Parse llms.txt

```python
# llms.txt contains URLs like:
# [Title](https://docs.claude.com/en/docs/claude-code/overview.md)
# [Titel](https://docs.claude.com/de/docs/claude-code/overview.md)
#           ────────────────── ── ──── ─────────── ───────────
#                  │           │   │       │           │
#              domain      language │   category   filename
#                               section
```

Parser extracts:
- Language: `en`, `de`, `es`, etc.
- Category: `claude-code`, `api`, etc.
- File path: `overview.md`

### Step 2: Apply Filters

```python
# User specifies: -l en -c claude-code
filtered = filter_by_criteria(
    parsed_data,
    language="en",
    category="claude-code"
)
# Result: Only English Claude Code files
```

### Step 3: Download Filtered Set

```bash
for file in filtered_files:
    url = "https://docs.claude.com/en/docs/claude-code/${file}"
    download(url)
```

## Data Structure

### llms.txt Format

```markdown
# Claude Docs

## Docs

- [Overview](https://docs.claude.com/en/docs/claude-code/overview.md): Description
- [Übersicht](https://docs.claude.com/de/docs/claude-code/overview.md): Beschreibung
- [API Reference](https://docs.claude.com/en/docs/api/messages.md): Description
...
```

### Parsed Structure

```json
{
  "by_language": {
    "en": {
      "claude-code": [
        {
          "title": "Overview",
          "url": "https://docs.claude.com/en/docs/claude-code/overview.md",
          "file_path": "overview.md",
          "language": "en",
          "category": "claude-code"
        },
        ...
      ],
      "api": [...]
    },
    "de": {...}
  },
  "all_languages": ["en", "de", "es", ...],
  "all_categories": ["claude-code", "api", ...]
}
```

## Real-World Examples

### Example 1: Documentation for German Users

```bash
# Download all German Claude Code docs
./download-docs.sh -l de -c claude-code -o ./docs-de

# Result:
docs-de/
├── getting-started/
│   ├── übersicht.md
│   ├── schnellstart.md
│   └── ...
└── [organized German documentation]
```

### Example 2: Multilingual Documentation Site

```bash
# Create docs for 3 languages
for lang in en de ja; do
  ./download-docs.sh -l $lang -c claude-code -o ./docs/$lang
done

# Result:
docs/
├── en/  (English docs)
├── de/  (German docs)
└── ja/  (Japanese docs)
```

### Example 3: API Documentation Only

```bash
# Just the API reference docs
./download-docs.sh -l en -c api -o ./api-docs

# Gets only API-related files
# No Claude Code CLI docs
# No general guides
```

### Example 4: Developer Documentation Collection

```bash
# Collect all developer-relevant docs in English
./download-docs.sh -l en -c claude-code -o ./dev-docs/claude-code
./download-docs.sh -l en -c api -o ./dev-docs/api
./download-docs.sh -l en -c build-with-claude -o ./dev-docs/guides
```

## Statistics

### Available Content

| Language | Code | Files |
|----------|------|-------|
| English | en | 108 |
| German | de | 119 |
| Spanish | es | 119 |
| French | fr | 119 |
| Indonesian | id | 119 |
| Italian | it | 119 |
| Japanese | ja | 119 |
| Korean | ko | 119 |
| Portuguese | pt | 119 |
| Russian | ru | 119 |

| Category | Files (all langs) |
|----------|-------------------|
| claude-code | 500 |
| build-with-claude | 290 |
| agents-and-tools | 140 |
| about-claude | 120 |
| test-and-evaluate | 100 |
| legal-center | 18 |

**Total combinations**: 10 languages × 6 categories = 60 different documentation sets!

## Key Benefits

### 1. Reusability
- One script works for all language/category combinations
- No need to modify code for different docs
- Easy to add new use cases

### 2. Flexibility
```bash
# Download just what you need
./download-docs.sh -l en -c claude-code  # 41 files, ~500KB

# Or everything
./download-docs.sh -l en  # All English docs, much larger
```

### 3. Discoverability
```bash
# Users can explore what's available
./download-docs.sh --list-languages
./download-docs.sh --list-categories
```

### 4. Maintainability
- Automatic: New categories in llms.txt work immediately
- No hardcoding: All filters dynamic
- Easy updates: Re-run with same command

### 5. International Support
- Download docs in user's native language
- Create multilingual documentation sites
- Support global teams

## Comparison

| Feature | Original | Reusable |
|---------|----------|----------|
| Languages | 1 (en) | 10 |
| Categories | 1 (claude-code) | 6 |
| Combinations | 1 | 60 |
| Hardcoded values | Yes | No |
| Discovery commands | No | Yes |
| Custom output dir | No | Yes |
| Filter options | None | Language + Category |
| Reusable for other docs | No | Yes |

## Technical Implementation

### Filter Architecture

```
User Input
    ↓
./download-docs.sh -l en -c claude-code
    ↓
Validate filters (list-languages, list-categories)
    ↓
python3 parse-llms-txt.py -l en -c claude-code
    ↓
Fetch llms.txt → Parse URLs → Filter by language → Filter by category
    ↓
Return: [{"url": "...", "file_path": "...", ...}, ...]
    ↓
Optional: Scrape navigation for organization
    ↓
Download each file via .md URL
    ↓
Organize by category structure
    ↓
Downloaded documentation
```

### Filter Logic

```python
def filter_by_criteria(parsed_data, language=None, category=None):
    """
    Filter parsed llms.txt data.

    If language=None: all languages
    If category=None: all categories
    """
    results = []

    # Get languages to include
    languages = [language] if language else all_languages

    for lang in languages:
        # Get categories to include
        categories = [category] if category else all_categories[lang]

        for cat in categories:
            results.extend(data[lang][cat])

    return results
```

## Future Enhancements

### Potential Additions

1. **Version filtering**
   ```bash
   ./download-docs.sh -l en -c api --version v2
   ```

2. **Date filtering**
   ```bash
   ./download-docs.sh -l en --updated-after 2025-01-01
   ```

3. **Search filtering**
   ```bash
   ./download-docs.sh -l en --search "authentication"
   ```

4. **Batch downloads**
   ```bash
   # Config file with multiple downloads
   ./download-docs.sh --batch downloads.yaml
   ```

5. **Diff mode**
   ```bash
   # Only download changed files
   ./download-docs.sh -l en -c claude-code --diff ./existing-docs
   ```

## Conclusion

The reusable solution transforms a single-purpose script into a flexible tool that:

✅ **Supports all languages** (10 languages)
✅ **Supports all categories** (6 categories)
✅ **60 different combinations** (10 × 6)
✅ **Dynamic filtering** (no hardcoding)
✅ **Easy discovery** (list commands)
✅ **Fully automated** (one command)

This makes it suitable for:
- International teams
- Documentation mirrors
- Offline documentation
- Custom documentation sites
- Multi-language support
- Specific topic downloads

The same code can download **any** Claude documentation in **any** language!
