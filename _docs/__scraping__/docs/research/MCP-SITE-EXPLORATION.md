# MCP Website Exploration Notes

**Target**: https://modelcontextprotocol.io
**Date**: 2025-10-10
**Objective**: Understand structure to apply similar scraping technique as Claude Code docs

## Discovery Phase

### ✅ What Works

1. **llms.txt exists**: `https://modelcontextprotocol.io/llms.txt`
   - Similar format to Claude docs
   - Contains 41 markdown files (46 lines total including headers)
   - Format: `- [Title](URL): Description`

2. **.md URLs work**: Direct markdown access confirmed
   - Example: `https://modelcontextprotocol.io/docs/getting-started/intro.md`
   - Returns: `content-type: text/markdown; charset=utf-8`
   - ✅ Same approach as Claude docs can be used!

### ❌ What Doesn't Work

1. **No sitemap.xml**: Returns 404
2. **No standard robots.txt**: Has content policy instead
3. **Different URL structure**: No `/en/docs/` prefix (no language code)

## File Structure Analysis

### Categories Identified (from llms.txt):

1. **about/** (1 file)
   - index.md - Main about page

2. **clients.md** (1 file)
   - Example clients list

3. **community/** (5 files)
   - antitrust.md
   - communication.md
   - governance.md
   - sep-guidelines.md
   - working-interest-groups.md

4. **development/** (1 file)
   - roadmap.md

5. **docs/develop/** (4 files)
   - build-client.md
   - build-server.md
   - connect-local-servers.md
   - connect-remote-servers.md

6. **docs/getting-started/** (1 file)
   - intro.md

7. **docs/learn/** (3 files)
   - architecture.md
   - client-concepts.md
   - server-concepts.md

8. **docs/** (2 files)
   - sdk.md
   - tools/inspector.md

9. **examples.md** (1 file)
   - Example servers list

10. **specification/2025-06-18/** (22 files)
    - **architecture/** (1)
      - index.md
    - **basic/** (4)
      - authorization.md
      - index.md
      - lifecycle.md
      - security_best_practices.md
      - transports.md
    - **basic/utilities/** (3)
      - cancellation.md
      - ping.md
      - progress.md
    - **client/** (3)
      - elicitation.md
      - roots.md
      - sampling.md
    - **server/** (4)
      - index.md
      - prompts.md
      - resources.md
      - tools.md
    - **server/utilities/** (3)
      - completion.md
      - logging.md
      - pagination.md
    - **Root files** (4)
      - changelog.md
      - index.md
      - schema.md
    - **versioning.md** (1)

11. **specification/versioning.md** (1 file)

**Total**: 41 markdown files

## URL Patterns

### Observed Patterns:
- Root level: `/{file}.md`
- Category level: `/{category}/{file}.md`
- Subcategory: `/{category}/{subcategory}/{file}.md`
- Deep nesting: `/specification/2025-06-18/{area}/utilities/{file}.md`

### Key Differences from Claude Docs:
- ❌ No language prefix (no `/en/`)
- ✅ Direct .md access works
- ✅ Has llms.txt with complete list
- ❌ No category metadata (no language/category filters)

## Similarities to Claude Code Approach

1. **llms.txt available** - Complete file list
2. **Direct .md URLs** - Can download markdown directly
3. **Clear category structure** - Organized by topic

## Differences from Claude Code

1. **Single language** - No multi-language support
2. **Versioned spec** - Has `/specification/2025-06-18/` versioned docs
3. **Flatter structure** - Categories are folders, not explicitly tagged
4. **No category in llms.txt** - Files listed but no category metadata

## Navigation Structure

### Website Navigation Analysis:

**Initial Assessment** (INCORRECT):
- ❌ Initially concluded "No fixed sidebar navigation found"
- ❌ Mistakenly thought llms.txt would be sufficient

**Corrected Assessment** (VERIFIED):
- ✅ **3-level hierarchical sidebar DOES exist!**
- ✅ Navigation structure: `<div id="navigation-items">`
- ✅ 4 main sections: Documentation, Specification, Community, About MCP
- ✅ Subsections with headers: `<h5 id="sidebar-title">`
- ✅ Collapsible groups (e.g., "Utilities" sections)
- ✅ Navigation order must be preserved

### Implication:
⚠️ **Navigation scraping IS required** - Must extract sidebar structure to preserve order
✅ **llms.txt + navigation merge** - Need both sources (like Claude docs)

## Sample Download Test

### Test File: `docs/getting-started/intro.md`
- ✅ Downloads successfully
- ✅ Clean markdown with custom MDX components (`<Frame>`, `<CardGroup>`)
- ✅ Similar to Claude docs (includes custom components)
- File size: ~3.4KB

## Key Findings Summary

### ✅ What We Can Use:
1. **llms.txt** - Complete file list (41 files)
2. **Direct .md URLs** - All files downloadable as markdown
3. **URL structure from llms.txt** - Provides complete file paths

### ❌ What We Don't Need:
1. **Navigation scraping** - No sidebar exists
2. **Language filtering** - Single language site
3. **Category detection** - Can infer from file paths

## Proposed Approach

**Strategy**: Simplified version of Claude Code scraper

1. **Parse llms.txt**
   - Extract all file URLs
   - Parse categories from file paths (folder structure)

2. **Download .md files**
   - Use URLs directly from llms.txt
   - Save with folder structure preserved

3. **Organization**
   - Use file path structure as categories:
     - `about/`
     - `community/`
     - `docs/develop/`
     - `docs/getting-started/`
     - `docs/learn/`
     - `specification/2025-06-18/`
     - etc.

4. **NO navigation scraping needed**
   - llms.txt already provides complete structure
   - File paths define organization

## Complexity Comparison

| Aspect | Claude Docs | MCP Docs |
|--------|-------------|----------|
| llms.txt | ✅ Yes | ✅ Yes |
| .md URLs | ✅ Yes | ✅ Yes |
| Navigation sidebar | ✅ Yes (complex) | ❌ No |
| Multi-language | ✅ Yes (10 langs) | ❌ No |
| Category metadata | ✅ Yes | ⚠️ Inferred from paths |
| Versioned docs | ❌ No | ✅ Yes (2025-06-18) |

**Conclusion**: MCP site is **SIMPLER** to scrape - just parse llms.txt and download!

## Next Steps for Exploration

- [x] Test sample .md download
- [x] Check if navigation sidebar exists on actual website
- [x] Analyze folder structure patterns
- [x] Determine if we need navigation scraping or if llms.txt is sufficient
- [x] Create detailed scraping plan
- [x] Propose tool reuse strategy

---

## Lessons Learned

### Discovery Process:

1. **Initial WebFetch Attempt**: Used WebFetch tool but couldn't see navigation
2. **Correction by User**: User pointed out 3-level navigation structure was missed
3. **HTML Inspection**: Used curl + grep to get raw HTML
4. **Navigation Found**: Located `<div id="navigation-items">` with complete structure
5. **Complete Extraction**: Scraped all 4 main sections to document full hierarchy

### Key Insights:

1. **Don't assume simplicity** - Initial assumption of "no navigation" was wrong
2. **Always inspect raw HTML** - WebFetch may not show all page elements
3. **User feedback is critical** - User caught error that would have led to wrong implementation
4. **Navigation IS important** - Preserving navigation order is as important for MCP as for Claude docs
5. **3-level hierarchy is complex** - More levels = more complexity in folder structure

### Final Assessment:

**MCP scraping complexity**: Similar to Claude Code docs (~4-5 hours)
- Both require navigation scraping
- Both require merging llms.txt + navigation data
- Both require numbered folders to preserve order
- MCP has 3 levels vs Claude's 2, but MCP has no language variants

**Status**: Ready to proceed with implementation using corrected understanding.
