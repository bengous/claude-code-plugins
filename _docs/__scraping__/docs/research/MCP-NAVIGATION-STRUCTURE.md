# MCP Website Navigation Structure

**Extracted**: 2025-10-10
**Source**: https://modelcontextprotocol.io

## Main Sections (Level 1)

The top navigation has 4 main tabs:
1. **Documentation** (`/docs/`)
2. **Specification** (`/specification/2025-06-18`)
3. **Community** (`/community/`)
4. **About MCP** (`/about/`)

---

## Section 1: Documentation

### Subsections (Level 2):

#### 1.1 Get started
- What is MCP? → `/docs/getting-started/intro`

#### 1.2 About MCP
- Architecture → `/docs/learn/architecture`
- Servers → `/docs/learn/server-concepts`
- Clients → `/docs/learn/client-concepts`
- Versioning → `/specification/versioning`

#### 1.3 Develop with MCP
- Connect to local MCP servers → `/docs/develop/connect-local-servers`
- Connect to remote MCP Servers → `/docs/develop/connect-remote-servers`
- Build an MCP server → `/docs/develop/build-server`
- Build an MCP client → `/docs/develop/build-client`
- SDKs → `/docs/sdk`

#### 1.4 Developer tools
- MCP Inspector → `/docs/tools/inspector`

---

## Section 2: Specification

### Top-Level Pages:

1. **Specification** → `/specification/2025-06-18` (Overview/index page)
2. **Key Changes** → `/specification/2025-06-18/changelog`
3. **Architecture** → `/specification/2025-06-18/architecture`

### Subsection: Base Protocol

4. **Overview** → `/specification/2025-06-18/basic`
5. **Lifecycle** → `/specification/2025-06-18/basic/lifecycle`
6. **Transports** → `/specification/2025-06-18/basic/transports`
7. **Authorization** → `/specification/2025-06-18/basic/authorization`
8. **Security Best Practices** → `/specification/2025-06-18/basic/security_best_practices`
9. **Utilities** (collapsible subsection):
   - Cancellation → `/specification/2025-06-18/basic/utilities/cancellation`
   - Ping → `/specification/2025-06-18/basic/utilities/ping`
   - Progress → `/specification/2025-06-18/basic/utilities/progress`

### Subsection: Client Features

10. **Roots** → `/specification/2025-06-18/client/roots`
11. **Sampling** → `/specification/2025-06-18/client/sampling`
12. **Elicitation** → `/specification/2025-06-18/client/elicitation`

### Subsection: Server Features

13. **Overview** → `/specification/2025-06-18/server`
14. **Prompts** → `/specification/2025-06-18/server/prompts`
15. **Resources** → `/specification/2025-06-18/server/resources`
16. **Tools** → `/specification/2025-06-18/server/tools`
17. **Utilities** (collapsible subsection):
   - Completion → `/specification/2025-06-18/server/utilities/completion`
   - Logging → `/specification/2025-06-18/server/utilities/logging`
   - Pagination → `/specification/2025-06-18/server/utilities/pagination`

### Bottom-Level Page:

18. **Schema Reference** → `/specification/2025-06-18/schema`

**Total Pages**: 23 (3 top-level + 5 Base Protocol + 3 utilities + 3 Client Features + 4 Server Features + 3 utilities + 1 Schema + 1 Versioning in root)

---

## Section 3: Community

### Top-Level Page:

1. **Contributor Communication** → `/community/communication`

### Subsection: Governance

2. **Governance and Stewardship** → `/community/governance`
3. **SEP Guidelines** → `/community/sep-guidelines`
4. **Working and Interest Groups** → `/community/working-interest-groups`
5. **Antitrust Policy** → `/community/antitrust`

### Subsection: Roadmap

6. **Roadmap** → `/development/roadmap`

### Subsection: Examples

7. **Example Clients** → `/clients`
8. **Example Servers** → `/examples`

**Total Pages**: 8

---

## Section 4: About MCP

**Navigation**: No sidebar navigation (single page or custom layout)

**URL**: `/about`

**Note**: The About MCP section appears to be a standalone page without hierarchical navigation.

---

## Notes

### Navigation Structure:

- **3-level hierarchy**: Level 1 (Main sections) → Level 2 (Subsections) → Level 3 (Individual pages)
- **4 main sections**: Documentation, Specification, Community, About MCP
- **Navigation order preserved** in HTML
- **Collapsible subsections**: Utilities sections under Base Protocol and Server Features can be expanded/collapsed
- **Cross-section references**: Some files may appear in multiple sections (e.g., Versioning appears in both Specification and Documentation navigation)

### Special Cases:

1. **Versioned specification folder**: `/specification/2025-06-18/` contains dated version
2. **Root-level files in navigation**: Community section references files at different path levels (`/community/`, `/development/`, `/clients`, `/examples`)
3. **About MCP**: No sidebar navigation, appears to be single custom page
4. **Subsection headers**: "Base Protocol", "Client Features", "Server Features", "Governance", "Roadmap", "Examples" are visual groupings, not actual pages

### Total File Count:

- **Documentation**: 10 pages
- **Specification**: 23 pages
- **Community**: 8 pages
- **About MCP**: 1 page (probably)
- **Versioning (root)**: 1 page (appears in multiple navs)
- **Total**: ~43 pages (accounting for cross-references)
