# Changelog

All notable changes to the Claude Documentation Scraper.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

#### Model Context Protocol (MCP) Scraper
- Complete MCP documentation downloader system (42 files from modelcontextprotocol.io)
- `scrape-mcp-navigation.py` - Extracts 3-level navigation hierarchy (sections → subsections → pages)
  - Scrapes 4 main sections: documentation, specification, community, about
  - Captures subsection structure (11 subsections total)
  - Filters noise (anchors, external links, duplicates)
  - Supports single-section or all-sections mode
- `parse-mcp-llms.py` - Parses llms.txt from MCP website
  - Extracts 42 files with metadata (title, URL, path, description)
  - Simpler than Claude parser (no language/category filtering needed)
  - Multiple output formats: json, urls, paths
- `download-mcp-docs.sh` - Orchestrates complete download with structure
  - Downloads all 42 MCP markdown files
  - Creates numbered folder structure (01-documentation, 02-specification, etc.)
  - Preserves subdirectory structure to avoid overwrites
  - Generates metadata with navigation tree
  - 4-step process: scrape nav → fetch llms.txt → create dirs → download files
- Subdirectory preservation logic for nested paths
  - Handles 5 `index.md` files in different subdirectories without overwrites
  - Maintains versioned spec structure (`2025-06-18/basic/utilities/`)
  - Deepest nesting: 4 levels preserved correctly
- Comprehensive MCP documentation in README
  - Usage examples for all 3 tools
  - Complete folder structure diagram
  - Comparison table (MCP vs Claude scrapers)
  - Metadata format documentation
  - 270+ lines of MCP-specific docs

#### Claude Code Scraper
- Numeric prefixes to files within categories (01-, 02-, etc.) to preserve navigation order
  - Overview/intro files now appear first instead of last alphabetically
  - AI agents and humans scan files in correct sequence
  - Example: `04-deployment/01-third-party-integrations.md` (Overview)
- Numeric prefixes to category folders (01-getting-started, 02-build-with-claude-code, etc.)
  - Preserves website navbar order instead of alphabetical sorting
  - Makes folder scanning intuitive and predictable
- Support for files appearing in multiple categories
  - Files like `quickstart.md` appear in both `getting-started` and `resources`
  - Scraper takes first/primary occurrence to avoid duplicates
- Process substitution for download loop to fix subshell variable issues
  - Download counter now shows correct progress (was showing 0/41)

### Changed
- Output structure from `$OUTPUT/$CATEGORY/$CATEGORY/` to `$OUTPUT/$CATEGORY/$LANGUAGE/`
  - Fixes redundant folder nesting
  - Example: `scraped/claude-code/en/` instead of `scraped/claude-code/claude-code/`
- Metadata file location from `__scraping__/data/` to scraped output folder
  - Each download now generates its own `.metadata.json` in output directory
  - Metadata travels with the downloaded docs
- HTTP status check to use regex pattern `HTTP/[0-9.]+ 200`
  - More robust than looking for literal "200 OK" string
- Use `jq keys_unsorted` instead of `jq keys` to preserve navigation order
  - Categories now appear in website order, not alphabetically
- Pass `-l`, `-c`, `-o` parameters to `scrape-navigation.py`
  - Makes navigation scraper reusable and configurable

### Removed
- Obsolete static `category-mapping.json` file
  - All category mappings now dynamically generated per scrape
- Empty `__scraping__/data/` directory
  - No longer needed since metadata is generated in output folder

### Fixed

#### Model Context Protocol (MCP) Scraper
- Download loop not executing in `download-mcp-docs.sh`
  - Process substitution wasn't working for jq JSON iteration
  - Fixed by saving JSON to temp file and processing from file
  - Changed arithmetic from `((var++))` to POSIX-compliant `var=$((var + 1))`
- File overwrites due to flat file placement
  - 5 `index.md` files were overwriting each other (42 downloads → 39 files)
  - Fixed by preserving subdirectory structure from URL paths
  - Now extracts relative paths and maintains nested directories
  - All 42 files download correctly without overwrites

#### Claude Code Scraper
- Download failures for files appearing in multiple categories
  - Files like `quickstart.md`, `setup.md`, `security.md`, etc. now download successfully
  - Was: 30/41 successful → Now: 41/41 successful
- stderr/stdout separation in `parse-llms-txt.py`
  - Status messages go to stderr, clean JSON to stdout
  - Prevents jq parse errors from mixed output
- Download counter showing 0/41 instead of actual count
  - Fixed by using process substitution instead of pipe (avoids subshell)

## [1.0.0] - 2025-10-10

### Added
- Initial release of Claude Documentation Scraper
- Three main scripts:
  - `download-docs.sh` - Main download orchestrator
  - `parse-llms-txt.py` - Parses llms.txt with language/category filters
  - `scrape-navigation.py` - Extracts navigation structure from website HTML
- Language filtering (10 languages supported: en, de, es, fr, id, it, ja, ko, pt, ru)
- Category filtering (6+ categories: claude-code, api, build-with-claude, etc.)
- Navigation structure extraction from website sidebar
- Organized folder structure separating tools from results:
  - `__scraping__/scripts/` - Executable scripts
  - `__scraping__/docs/` - Documentation
  - `__scraping__/examples/` - Sample downloads
  - `scraped/` - Downloaded documentation (gitignored)
- Legacy script preservation in `__scraping__/scripts/_legacy/`
- Comprehensive documentation:
  - Quick start guide
  - Technical details
  - Research notes
  - Usage examples

### Features
- Downloads markdown files with `.md` URL suffix
- Preserves website navigation structure in JSON
- Creates organized folder hierarchy
- Supports both structured (with navigation) and flat (llms.txt only) modes
- Colorized terminal output
- Progress tracking with counters
- Download statistics summary
- Automatic directory creation
- Failed download cleanup
