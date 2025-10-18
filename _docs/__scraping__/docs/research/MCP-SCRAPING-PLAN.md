# MCP Documentation Scraping Plan

**Date**: 2025-10-10
**Target**: https://modelcontextprotocol.io
**Goal**: Scrape all MCP documentation using similar approach to Claude Code docs

---

## Executive Summary

**Update**: After thorough exploration, MCP docs are **DIFFERENT** from initial assessment:

- ❌ Navigation scraping IS needed (3-level hierarchical sidebar exists!)
- ✅ No language/category filtering needed (single language)
- ⚠️ Must combine llms.txt + navigation scraping (like Claude docs)
- ✅ llms.txt provides file list, navigation provides order

**Revised Effort**: ~4-5 hours (similar complexity to Claude docs due to navigation)

---

## Comparison: Claude Code vs MCP Docs

| Feature | Claude Code | MCP Docs | Impact |
|---------|-------------|----------|--------|
| llms.txt | ✅ Complex format | ✅ Simple format | Easier parsing |
| .md URLs | ✅ Yes | ✅ Yes | Same download method |
| Navigation | ✅ Complex sidebar | ✅ 3-level sidebar | **Scraping required!** |
| Languages | ✅ 10 languages | ❌ English only | No filtering |
| Categories | ✅ Explicit metadata | ⚠️ Infer from paths | Simple extraction |
| Versioning | ❌ No | ✅ Yes (2025-06-18) | Handle in paths |
| Total Files | 41 (claude-code) | 41 (all) | Same scale |

---

## Revised Approach

**CORRECTION**: Initial assumption was wrong - navigation DOES exist and must be preserved!

### Phase 1: Navigation Scraper (REQUIRED)

Create `scrape-mcp-navigation.py`:

**Purpose**: Extract 3-level navigation hierarchy from MCP website

**Input URLs** to scrape:
- `/docs/getting-started/intro` (Documentation section)
- `/specification/2025-06-18` (Specification section)
- `/community/communication` (Community section)
- `/about` (About MCP section)

**Output** (JSON):
```json
{
  "documentation": {
    "order": 1,
    "subsections": {
      "get-started": {
        "order": 1,
        "pages": ["intro"]
      },
      "about-mcp": {
        "order": 2,
        "pages": ["architecture", "server-concepts", "client-concepts", "versioning"]
      },
      ...
    }
  },
  "specification": {
    "order": 2,
    "top_level": ["index", "changelog", "architecture"],
    "subsections": {
      "base-protocol": {
        "order": 1,
        "pages": ["basic", "lifecycle", "transports", "authorization", "security_best_practices"],
        "utilities": ["cancellation", "ping", "progress"]
      },
      ...
    }
  },
  ...
}
```

**Logic**:
1. Fetch HTML from each main section
2. Parse `<div id="navigation-items">` structure
3. Extract subsection headers (`<h5 id="sidebar-title">`)
4. Extract page links and preserve order
5. Handle collapsible sections (Utilities)
6. Map URLs to file paths

**Key Difference from Claude scraper**:
- ❌ No language filtering
- ✅ 3 levels instead of 2
- ✅ Handle collapsible subsections
- ✅ Handle cross-section references

### Phase 2: llms.txt Parser (SAME)

Create `parse-mcp-llms.py`:

**Purpose**: Get complete file list with metadata

**Input**: `https://modelcontextprotocol.io/llms.txt`

**Output** (JSON):
```json
[
  {
    "title": "What is the Model Context Protocol (MCP)?",
    "url": "https://modelcontextprotocol.io/docs/getting-started/intro.md",
    "file_path": "docs/getting-started/intro.md",
    "description": "Introduction to MCP"
  },
  ...
]
```

**Logic**:
1. Fetch llms.txt
2. Parse markdown list format: `- [Title](URL): Description`
3. Extract URL, title, description
4. Derive file_path from URL

### Phase 3: Combined Download Script (NEW APPROACH)

Create `download-mcp-docs.sh`:

**Purpose**: Combine navigation + llms.txt to download with proper structure

**Usage**:
```bash
./download-mcp-docs.sh -o ../../scraped/mcp
```

**Flow**:
```
1. Run scrape-mcp-navigation.py → navigation.json
2. Run parse-mcp-llms.py → files.json
3. Merge: Match files from llms.txt with navigation structure
4. Create numbered folder structure matching navigation
5. Download all .md files to correct locations
6. Generate .metadata.json with navigation structure
```

**Key Features**:
- Numbered folders (01-documentation/, 02-specification/, etc.)
- Numbered files within folders preserving nav order
- Metadata includes navigation tree
- Handle files appearing in multiple sections

### Phase 4: Folder Structure (REVISED)

**Output Structure** (with navigation-based numbering):
```
scraped/
└── mcp/
    ├── .metadata.json                                    ← Scrape info + stats + navigation tree
    ├── 01-documentation/
    │   ├── 01-get-started/
    │   │   └── 01-intro.md                               ← What is MCP?
    │   ├── 02-about-mcp/
    │   │   ├── 01-architecture.md
    │   │   ├── 02-server-concepts.md
    │   │   ├── 03-client-concepts.md
    │   │   └── 04-versioning.md                          ← Cross-reference to /specification/versioning
    │   ├── 03-develop-with-mcp/
    │   │   ├── 01-connect-local-servers.md
    │   │   ├── 02-connect-remote-servers.md
    │   │   ├── 03-build-server.md
    │   │   ├── 04-build-client.md
    │   │   └── 05-sdk.md
    │   └── 04-developer-tools/
    │       └── 01-inspector.md
    ├── 02-specification/
    │   ├── 01-specification.md                           ← Index/overview
    │   ├── 02-changelog.md                               ← Key Changes
    │   ├── 03-architecture.md
    │   ├── 04-base-protocol/
    │   │   ├── 01-overview.md                            ← basic/index.md
    │   │   ├── 02-lifecycle.md
    │   │   ├── 03-transports.md
    │   │   ├── 04-authorization.md
    │   │   ├── 05-security-best-practices.md
    │   │   └── 06-utilities/
    │   │       ├── 01-cancellation.md
    │   │       ├── 02-ping.md
    │   │       └── 03-progress.md
    │   ├── 05-client-features/
    │   │   ├── 01-roots.md
    │   │   ├── 02-sampling.md
    │   │   └── 03-elicitation.md
    │   ├── 06-server-features/
    │   │   ├── 01-overview.md                            ← server/index.md
    │   │   ├── 02-prompts.md
    │   │   ├── 03-resources.md
    │   │   ├── 04-tools.md
    │   │   └── 05-utilities/
    │   │       ├── 01-completion.md
    │   │       ├── 02-logging.md
    │   │       └── 03-pagination.md
    │   └── 07-schema-reference.md
    ├── 03-community/
    │   ├── 01-communication.md                           ← Contributor Communication
    │   ├── 02-governance/
    │   │   ├── 01-governance-and-stewardship.md
    │   │   ├── 02-sep-guidelines.md
    │   │   ├── 03-working-interest-groups.md
    │   │   └── 04-antitrust.md
    │   ├── 03-roadmap/
    │   │   └── 01-roadmap.md
    │   └── 04-examples/
    │       ├── 01-example-clients.md
    │       └── 02-example-servers.md
    └── 04-about-mcp/
        └── 01-about.md                                   ← Single page

```

**Key Changes from Initial Plan**:
- ✅ **Numbered folders** match navigation section order (01-, 02-, 03-, 04-)
- ✅ **Numbered subsection folders** match navigation subsection order
- ✅ **Numbered files** match navigation page order within each subsection
- ✅ **Folder names** derived from navigation subsection headers
- ✅ **File names** simplified (kebab-case) but preserve navigation order
- ✅ **Cross-references** handled (versioning.md appears in documentation but stored in specification)
- ❌ **No version folder** - flattened to preserve navigation order

---

## Tool Reuse Strategy (REVISED)

### Reuse AS-IS:
**None** - MCP requires similar approach to Claude but with adaptations

### Reuse with SIGNIFICANT MODIFICATIONS:

#### 1. `scrape-navigation.py` → `scrape-mcp-navigation.py`

**Changes needed**:
```python
# KEEP:
# - HTML fetching and parsing
# - Navigation structure extraction
# - JSON output format

# MODIFY:
# - Parse <div id="navigation-items"> instead of Algolia data
# - Handle 3-level hierarchy (sections → subsections → pages)
# - Extract subsection headers <h5 id="sidebar-title">
# - Handle collapsible subsections (Utilities)
# - No language parameter
# - Scrape 4 different main sections independently

# NEW:
# - Parse both <ul class="sidebar-group"> and grouped subsections
# - Handle cross-section file references
# - Map versioned paths (2025-06-18)
```

**Estimated Lines**: ~200 lines (similar to Claude's ~180 lines)

#### 2. `parse-llms-txt.py` → `parse-mcp-llms.py`

**Changes needed**:
```python
# KEEP:
# - URL fetching
# - Markdown list parsing
# - JSON output

# MODIFY:
# - Simpler regex: `\[(.+?)\]\((.+?)\):\s*(.+)`
# - No language filtering
# - No category parameter

# NEW:
# - Handle MCP URL structure
# - Extract file paths directly
```

**Estimated Lines**: ~100 lines (vs 200+ for Claude)

#### 3. `download-docs.sh` → `download-mcp-docs.sh`

**Changes needed**:
```bash
# KEEP:
# - .md URL downloads
# - Folder structure creation with numbering
# - Metadata generation with navigation tree
# - Progress tracking
# - Error handling
# - Navigation + llms.txt merging logic

# REMOVE:
# - Language parameter (-l)
# - Category parameter (-c)

# MODIFY:
# - Call scrape-mcp-navigation.py instead of scrape-navigation.py
# - Handle 3-level folder structure (section/subsection/page)
# - No language in metadata
# - Single output folder (no language subfolder)
```

**Estimated Lines**: ~250 lines (vs 290+ for Claude)

### New Tools Needed:

**None!** - All tools can be adapted from Claude scraper

---

## Metadata Format

**File**: `.metadata.json`

```json
{
  "scrape_info": {
    "timestamp": "2025-10-10T12:00:00Z",
    "source_url": "https://modelcontextprotocol.io",
    "scraper_version": "1.0.0"
  },
  "stats": {
    "total_files": 41,
    "successful": 41,
    "failed": 0,
    "total_size": "256K"
  },
  "categories": {
    "about": 1,
    "community": 5,
    "development": 1,
    "docs": 10,
    "specification": 23,
    "root": 1
  }
}
```

**Simpler than Claude**:
- No language field
- No navigation structure (not needed)
- Category counts instead of navigation tree

---

## Implementation Steps (REVISED)

### Step 1: Create Navigation Scraper (~1.5 hours)

```bash
# Create navigation scraper based on Claude's version
cp scripts/scrape-navigation.py scripts/scrape-mcp-navigation.py

# Major modifications:
# 1. Change HTML parsing to extract <div id="navigation-items">
# 2. Parse subsection headers <h5 id="sidebar-title">
# 3. Handle 3-level hierarchy (sections/subsections/pages)
# 4. Handle collapsible sections
# 5. Scrape 4 different main section URLs
# 6. Remove language logic
# 7. Test with each main section URL

# Test it
./scripts/scrape-mcp-navigation.py --url "https://modelcontextprotocol.io/docs/getting-started/intro" --section documentation
./scripts/scrape-mcp-navigation.py --url "https://modelcontextprotocol.io/specification/2025-06-18" --section specification
# etc.
```

### Step 2: Create llms.txt Parser (~30 min)

```bash
# Create simplified parser
cp scripts/parse-llms-txt.py scripts/parse-mcp-llms.py

# Modifications:
# 1. Remove language/category parameters
# 2. Simplify URL parsing for MCP structure
# 3. Test with MCP llms.txt

# Test it
./scripts/parse-mcp-llms.py https://modelcontextprotocol.io/llms.txt | jq .
```

### Step 3: Create Download Script (~2 hours)

```bash
# Create downloader based on Claude's version
cp scripts/download-docs.sh scripts/download-mcp-docs.sh

# Modifications:
# 1. Remove language parameter
# 2. Call scrape-mcp-navigation.py for each main section
# 3. Merge navigation from all 4 sections
# 4. Match llms.txt files with navigation
# 5. Create 3-level numbered folder structure
# 6. Handle cross-section file references
# 7. Update metadata format (no language field)
# 8. Test with small subset first

# Test with sample
./scripts/download-mcp-docs.sh -o ../../scraped/mcp-test --limit 5
```

### Step 4: Test & Debug (~45 min)

```bash
# Test parser
./scripts/parse-mcp-llms.py https://modelcontextprotocol.io/llms.txt | jq . | head -50

# Test navigation scraper for each section
./scripts/scrape-mcp-navigation.py --url "https://modelcontextprotocol.io/docs/getting-started/intro" | jq .

# Test download (sample - first 10 files)
./scripts/download-mcp-docs.sh -o ../../scraped/mcp-test --limit 10

# Verify structure matches navigation
tree ../../scraped/mcp-test
cat ../../scraped/mcp-test/.metadata.json | jq .
```

### Step 5: Full Download & Verification (~15 min)

```bash
# Clean test
rm -rf ../../scraped/mcp-test

# Full download
./scripts/download-mcp-docs.sh -o ../../scraped/mcp

# Verify
find ../../scraped/mcp -name "*.md" | wc -l  # Should be ~43
ls -la ../../scraped/mcp/                     # Should see 01-documentation, 02-specification, etc.
cat ../../scraped/mcp/.metadata.json | jq .navigation  # Check navigation structure
```

### Step 6: Documentation (~30 min)

- Update README with MCP scraper docs
- Document navigation structure preservation
- Add comparison table: Claude vs MCP scrapers
- Document folder numbering strategy
- Add troubleshooting section

**Total Time**: ~5 hours

---

## Edge Cases & Considerations

### 1. Versioned Specification Folder

**Issue**: `/specification/2025-06-18/` contains a date

**Solution**:
- Keep as-is (preserve versioning)
- Future-proof: if new version appears, both will coexist

### 2. Root-Level Files

**Issue**: `clients.md`, `examples.md` at root

**Solution**:
- Save to root of scraped folder
- No special handling needed

### 3. Deep Nesting

**Issue**: Some files 5 levels deep

**Solution**:
- `mkdir -p` handles this automatically
- No special handling needed

### 4. File Name Conflicts

**Issue**: Multiple `index.md` files in different folders

**Solution**:
- Folder structure keeps them separate
- No conflicts

---

## Testing Strategy

### Unit Tests:

1. **Parser**:
   - [ ] Parses all 41 entries correctly
   - [ ] Extracts titles accurately
   - [ ] Derives correct categories
   - [ ] Handles root-level files
   - [ ] Handles deep nesting

2. **Downloader**:
   - [ ] Creates all folders
   - [ ] Downloads all 41 files
   - [ ] Preserves folder structure
   - [ ] Generates correct metadata
   - [ ] Handles errors gracefully

### Integration Test:

```bash
# Full workflow
./download-mcp-docs.sh -o ../../scraped/mcp

# Verification checks
[ $(find ../../scraped/mcp -name "*.md" | wc -l) -eq 41 ]
[ -f ../../scraped/mcp/.metadata.json ]
[ -d ../../scraped/mcp/specification/2025-06-18 ]
```

---

## Success Criteria

### Functional Requirements:
- [ ] All ~43 files downloaded successfully
- [ ] **Folder structure matches website navigation** (not just llms.txt paths!)
- [ ] Navigation order preserved with numbered folders/files
- [ ] 4 main sections created: 01-documentation, 02-specification, 03-community, 04-about-mcp
- [ ] Subsections properly nested and numbered
- [ ] Cross-section file references handled correctly
- [ ] No download errors or missing files

### Data Quality:
- [ ] Metadata generated with complete navigation tree
- [ ] Files are valid markdown
- [ ] File names are kebab-case and descriptive
- [ ] Folder names match navigation subsection headers

### Performance:
- [ ] Total download size < 1 MB
- [ ] Execution time < 3 minutes
- [ ] Navigation scraping completes for all 4 sections

### Verification:
- [ ] `tree` output matches expected folder structure diagram
- [ ] `.metadata.json` contains navigation hierarchy
- [ ] File count matches expected: `find scraped/mcp -name "*.md" | wc -l` ≈ 43
- [ ] Manually verify folder numbering matches website navigation order

---

## Comparison: MCP vs Claude Scraper

### Similarities:
1. **Navigation scraping required** - Both have hierarchical sidebar navigation
2. **llms.txt + navigation merge** - Both need to combine data sources
3. **Numbered folders** - Both preserve navigation order with numbering
4. **Metadata with navigation tree** - Both store complete structure
5. **Similar complexity** - ~4-5 hours implementation time

### MCP Advantages:
1. **Single language** - No language filtering or multi-language support needed
2. **Simpler llms.txt** - Easier to parse format
3. **Fewer files** - ~43 files vs potentially hundreds across all languages
4. **No category parameter** - All files in single output structure

### MCP Challenges:
1. **3-level hierarchy** - One more level than Claude (sections/subsections/pages)
2. **Collapsible sections** - Must handle expand/collapse groups (Utilities)
3. **Cross-section files** - Files appearing in multiple navigation locations
4. **Versioned paths** - Must handle `/2025-06-18/` dated folders
5. **Multiple main sections** - Must scrape 4 different main section URLs

---

## Deliverables

### Scripts:
1. `parse-mcp-llms.py` - Parse MCP llms.txt
2. `download-mcp-docs.sh` - Download all MCP docs

### Documentation:
1. `MCP-SITE-EXPLORATION.md` - This research
2. `MCP-SCRAPING-PLAN.md` - This plan
3. Updated `README.md` - Include MCP scraper docs

### Output:
1. `scraped/mcp/` - All downloaded MCP documentation
2. `scraped/mcp/.metadata.json` - Scrape metadata

---

## Open Questions

1. **File numbering**: Do we want numbered folders/files like Claude docs?
   - **Recommendation**: NO - no navigation order to preserve

2. **Separate scraped folder**: `scraped/claude-code/` vs `scraped/mcp/`?
   - **Recommendation**: YES - keep separate for clarity

3. **Reuse tools or create new ones**: Modify existing vs create new?
   - **Recommendation**: CREATE NEW - simpler, clearer separation

4. **Update frequency**: How often should we re-scrape?
   - **Recommendation**: Same as Claude docs - manual as needed

---

## Next Steps

**Status**: ✅ Exploration and planning complete!

**Ready to implement** with corrected understanding:

### Phase 1: Tool Development (~4 hours)
1. Create `scrape-mcp-navigation.py` - Extract 3-level navigation from all 4 main sections
2. Create `parse-mcp-llms.py` - Parse llms.txt for file list
3. Create `download-mcp-docs.sh` - Merge navigation + files, create numbered structure

### Phase 2: Testing & Verification (~1 hour)
4. Test navigation scraper on each main section
5. Test with sample download (10 files)
6. Verify folder structure matches navigation
7. Full download and validation

### Phase 3: Documentation (~30 min)
8. Update README with MCP scraper documentation
9. Add comparison: Claude vs MCP scrapers
10. Document folder numbering strategy

**Estimated completion**: ~5 hours from approval

**Awaiting user approval** to proceed with implementation.
