#!/usr/bin/env bash
#
# fetch-claude-code-docs-organized.sh
# Fetches all Claude Code documentation in English and organizes by category
#

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m' # No Color

# Configuration
readonly BASE_URL="https://docs.claude.com/en/docs/claude-code"
readonly DOCS_DIR="$(dirname "$0")/organized-docs"
readonly SCRIPT_DIR="$(dirname "$0")"

# Counters
total_files=0
successful_downloads=0
failed_downloads=0

# Category mapping (matching website navigation)
declare -A CATEGORY_MAPPING=(
    ["getting-started"]="overview.md quickstart.md setup.md common-workflows.md"
    ["build-with-claude-code"]="sub-agents.md plugins.md output-styles.md hooks-guide.md headless.md github-actions.md gitlab-ci-cd.md mcp.md troubleshooting.md"
    ["claude-code-sdk"]="migration-guide.md"
    ["deployment"]="third-party-integrations.md amazon-bedrock.md google-vertex-ai.md network-config.md llm-gateway.md devcontainer.md"
    ["administration"]="iam.md security.md data-usage.md monitoring-usage.md costs.md analytics.md plugin-marketplaces.md"
    ["configuration"]="settings.md vs-code.md jetbrains.md terminal-config.md model-config.md memory.md statusline.md"
    ["reference"]="cli-reference.md interactive-mode.md slash-commands.md checkpointing.md hooks.md plugins-reference.md"
    ["resources"]="legal-and-compliance.md"
)

# Category display names
declare -A CATEGORY_NAMES=(
    ["getting-started"]="Getting Started"
    ["build-with-claude-code"]="Build with Claude Code"
    ["claude-code-sdk"]="Claude Code SDK"
    ["deployment"]="Deployment"
    ["administration"]="Administration"
    ["configuration"]="Configuration"
    ["reference"]="Reference"
    ["resources"]="Resources"
)

# Category order
CATEGORY_ORDER=(
    "getting-started"
    "build-with-claude-code"
    "claude-code-sdk"
    "deployment"
    "administration"
    "configuration"
    "reference"
    "resources"
)

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude Code Documentation Fetcher (Organized)            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Create base directory
mkdir -p "$DOCS_DIR"

# Create category directories and count total files
echo -e "${YELLOW}📁 Creating category folders...${NC}"
for category in "${CATEGORY_ORDER[@]}"; do
    category_dir="$DOCS_DIR/$category"
    mkdir -p "$category_dir"

    # Count files in this category
    file_count=$(echo "${CATEGORY_MAPPING[$category]}" | wc -w)
    total_files=$((total_files + file_count))

    category_name="${CATEGORY_NAMES[$category]}"
    echo -e "  ${CYAN}• ${category_name}${NC} ($file_count files)"
done
echo ""
echo -e "${GREEN}✓ Total files to download: ${total_files}${NC}"
echo ""

read -p "$(echo -e "${YELLOW}Proceed with download? [Y/n]:${NC} ")" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]] && [[ -n $REPLY ]]; then
    echo -e "${RED}Download cancelled.${NC}"
    exit 0
fi

echo ""
echo -e "${BLUE}Starting download...${NC}"
echo ""

current_file=0

# Download files by category
for category in "${CATEGORY_ORDER[@]}"; do
    category_dir="$DOCS_DIR/$category"
    category_name="${CATEGORY_NAMES[$category]}"

    echo -e "${CYAN}━━━ ${category_name} ━━━${NC}"

    # Download each file in this category
    for filename in ${CATEGORY_MAPPING[$category]}; do
        ((current_file++))
        url="$BASE_URL/$filename"
        output_path="$category_dir/$filename"

        # Progress indicator
        printf "${BLUE}[%3d/%3d]${NC} %-40s " "$current_file" "$total_files" "$filename"

        if curl -sSf "$url" -o "$output_path"; then
            file_size=$(du -h "$output_path" | cut -f1)
            echo -e "${GREEN}✓${NC} (${file_size})"
            ((successful_downloads++))
        else
            echo -e "${RED}✗ Failed${NC}"
            ((failed_downloads++))
            rm -f "$output_path" 2>/dev/null || true
        fi
    done
    echo ""
done

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Download Summary                                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e "${GREEN}✓ Successful: ${successful_downloads}${NC}"
if [[ $failed_downloads -gt 0 ]]; then
    echo -e "${RED}✗ Failed: ${failed_downloads}${NC}"
fi
echo -e "${BLUE}📁 Output directory: ${DOCS_DIR}${NC}"
echo ""

# Calculate total size
total_size=$(du -sh "$DOCS_DIR" 2>/dev/null | cut -f1 || echo "0")
echo -e "${GREEN}Total size: ${total_size}${NC}"
echo ""

# Create main index file
index_file="$DOCS_DIR/INDEX.md"
echo "# Claude Code Documentation Index" > "$index_file"
echo "" >> "$index_file"
echo "Downloaded on: $(date '+%Y-%m-%d %H:%M:%S')" >> "$index_file"
echo "Total files: $successful_downloads" >> "$index_file"
echo "" >> "$index_file"
echo "---" >> "$index_file"
echo "" >> "$index_file"

# Add categorized file listings
for category in "${CATEGORY_ORDER[@]}"; do
    category_name="${CATEGORY_NAMES[$category]}"
    category_dir="$DOCS_DIR/$category"

    echo "## ${category_name}" >> "$index_file"
    echo "" >> "$index_file"

    # List files in this category
    for filename in ${CATEGORY_MAPPING[$category]}; do
        filepath="$category_dir/$filename"
        if [[ -f "$filepath" ]]; then
            # Extract title from first heading
            title=$(grep -m 1 "^# " "$filepath" 2>/dev/null | sed 's/^# //' || echo "$filename")
            echo "- [$title](./$category/$filename)" >> "$index_file"
        fi
    done
    echo "" >> "$index_file"
done

# Create per-category index files
for category in "${CATEGORY_ORDER[@]}"; do
    category_name="${CATEGORY_NAMES[$category]}"
    category_dir="$DOCS_DIR/$category"
    category_index="$category_dir/README.md"

    echo "# ${category_name}" > "$category_index"
    echo "" >> "$category_index"

    for filename in ${CATEGORY_MAPPING[$category]}; do
        filepath="$category_dir/$filename"
        if [[ -f "$filepath" ]]; then
            title=$(grep -m 1 "^# " "$filepath" 2>/dev/null | sed 's/^# //' || echo "$filename")
            echo "- [$title](./$filename)" >> "$category_index"
        fi
    done
done

echo -e "${GREEN}✓ Created main index: ${index_file}${NC}"
echo -e "${GREEN}✓ Created category indexes (README.md in each folder)${NC}"
echo ""
echo -e "${CYAN}📂 Folder structure:${NC}"
tree -L 2 -C "$DOCS_DIR" 2>/dev/null || find "$DOCS_DIR" -type d | sed 's|[^/]*/| |g'
echo ""
echo -e "${GREEN}All done! 🎉${NC}"
