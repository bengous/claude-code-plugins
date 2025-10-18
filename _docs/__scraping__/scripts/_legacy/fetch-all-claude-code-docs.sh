#!/usr/bin/env bash
#
# fetch-all-claude-code-docs.sh
# Fetches all Claude Code documentation in English from docs.claude.com
#

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Configuration
readonly BASE_URL="https://docs.claude.com"
readonly DOCS_DIR="$(dirname "$0")/downloaded"
readonly LLMS_TXT="${BASE_URL}/llms.txt"

# Counters
total_files=0
successful_downloads=0
failed_downloads=0

# Create output directory
mkdir -p "$DOCS_DIR"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude Code Documentation Fetcher                        ║${NC}"
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo ""
echo -e "${YELLOW}📥 Fetching list of available documentation...${NC}"

# Fetch and parse the llms.txt file for Claude Code docs in English
mapfile -t doc_urls < <(curl -sS "$LLMS_TXT" | grep -oP 'https://docs\.claude\.com/en/docs/claude-code/[^)]+\.md')

total_files=${#doc_urls[@]}

echo -e "${GREEN}✓ Found ${total_files} Claude Code documentation files${NC}"
echo ""

# Display all files that will be downloaded
echo -e "${BLUE}Files to download:${NC}"
for url in "${doc_urls[@]}"; do
    filename=$(basename "$url")
    echo -e "  • ${filename}"
done
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

# Download each file
for i in "${!doc_urls[@]}"; do
    url="${doc_urls[$i]}"
    filename=$(basename "$url")
    output_path="$DOCS_DIR/$filename"

    # Progress indicator
    current=$((i + 1))
    printf "${BLUE}[%3d/%3d]${NC} Downloading %s... " "$current" "$total_files" "$filename"

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

# Summary
echo ""
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
total_size=$(du -sh "$DOCS_DIR" | cut -f1)
echo -e "${GREEN}Total size: ${total_size}${NC}"
echo ""

# Create an index file
index_file="$DOCS_DIR/INDEX.md"
echo "# Claude Code Documentation Index" > "$index_file"
echo "" >> "$index_file"
echo "Downloaded on: $(date '+%Y-%m-%d %H:%M:%S')" >> "$index_file"
echo "Total files: $successful_downloads" >> "$index_file"
echo "" >> "$index_file"
echo "## Files" >> "$index_file"
echo "" >> "$index_file"

# List all downloaded files in the index
for file in "$DOCS_DIR"/*.md; do
    if [[ "$(basename "$file")" != "INDEX.md" ]]; then
        filename=$(basename "$file")
        # Extract title from first heading if available
        title=$(grep -m 1 "^# " "$file" 2>/dev/null | sed 's/^# //' || echo "$filename")
        echo "- [$title](./$filename)" >> "$index_file"
    fi
done | sort

echo -e "${GREEN}✓ Created index file: ${index_file}${NC}"
echo ""
echo -e "${GREEN}All done! 🎉${NC}"
