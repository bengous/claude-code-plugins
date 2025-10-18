# Claude Code Documentation Category Structure

This document maps the 41 documentation files to their website categories.

## Category Overview

The Claude Code documentation is organized into 8 main categories, matching the official website navigation at https://docs.claude.com.

---

## 📚 Getting Started (4 files)

Introduction and initial setup for Claude Code.

- `overview.md` - Claude Code overview
- `quickstart.md` - Quickstart guide
- `setup.md` - Set up Claude Code
- `common-workflows.md` - Common workflows

---

## 🛠️ Build with Claude Code (9 files)

Core features and tools for building with Claude Code.

- `sub-agents.md` - Subagents (specialized AI)
- `plugins.md` - Plugins system
- `output-styles.md` - Output styles customization
- `hooks-guide.md` - Get started with hooks (tutorial)
- `headless.md` - Headless mode (programmatic usage)
- `github-actions.md` - GitHub Actions integration
- `gitlab-ci-cd.md` - GitLab CI/CD integration
- `mcp.md` - Model Context Protocol (MCP)
- `troubleshooting.md` - Troubleshooting guide

---

## 🔄 Claude Code SDK (1 file)

SDK-related documentation.

- `migration-guide.md` - Migrate to Claude Agent SDK

---

## 🚀 Deployment (6 files)

Enterprise deployment and cloud platform configurations.

- `third-party-integrations.md` - Enterprise deployment overview
- `amazon-bedrock.md` - Claude Code on Amazon Bedrock
- `google-vertex-ai.md` - Claude Code on Google Vertex AI
- `network-config.md` - Enterprise network configuration
- `llm-gateway.md` - LLM gateway configuration
- `devcontainer.md` - Development containers

---

## 🔐 Administration (7 files)

Administrative features, security, and monitoring.

- `iam.md` - Identity and Access Management
- `security.md` - Security safeguards
- `data-usage.md` - Data usage policies
- `monitoring-usage.md` - Monitoring with OpenTelemetry
- `costs.md` - Manage costs effectively
- `analytics.md` - Analytics and usage insights
- `plugin-marketplaces.md` - Plugin marketplaces

---

## ⚙️ Configuration (7 files)

Settings and environment configuration.

- `settings.md` - Claude Code settings
- `vs-code.md` - Visual Studio Code integration
- `jetbrains.md` - JetBrains IDEs integration
- `terminal-config.md` - Optimize terminal setup
- `model-config.md` - Model configuration
- `memory.md` - Manage Claude's memory
- `statusline.md` - Status line configuration

---

## 📖 Reference (6 files)

Technical reference documentation.

- `cli-reference.md` - Complete CLI reference
- `interactive-mode.md` - Interactive mode reference
- `slash-commands.md` - Slash commands
- `checkpointing.md` - Checkpointing (track & rewind edits)
- `hooks.md` - Hooks reference (API reference)
- `plugins-reference.md` - Plugins reference

---

## 📋 Resources (1 file)

Additional resources and legal information.

- `legal-and-compliance.md` - Legal and compliance

---

## Summary Statistics

- **Total files**: 41
- **Total categories**: 8
- **Largest category**: Build with Claude Code (9 files)
- **Smallest categories**: Claude Code SDK, Resources (1 file each)

## Usage

To download all documentation organized by category:

```bash
./fetch-claude-code-docs-organized.sh
```

This will create the following structure:

```
organized-docs/
├── INDEX.md
├── getting-started/
│   ├── README.md
│   ├── overview.md
│   ├── quickstart.md
│   ├── setup.md
│   └── common-workflows.md
├── build-with-claude-code/
│   ├── README.md
│   └── [9 files]
├── claude-code-sdk/
│   ├── README.md
│   └── migration-guide.md
├── deployment/
│   ├── README.md
│   └── [6 files]
├── administration/
│   ├── README.md
│   └── [7 files]
├── configuration/
│   ├── README.md
│   └── [7 files]
├── reference/
│   ├── README.md
│   └── [6 files]
└── resources/
    ├── README.md
    └── legal-and-compliance.md
```

Each category folder contains:
- A `README.md` with links to all files in that category
- All markdown documentation files for that category

The root `INDEX.md` provides a complete overview with all categories and files.
