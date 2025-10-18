#!/usr/bin/env bash
#
# download-organized-docs.sh
# Complete solution: Scrape navigation + llms.txt verification + organized download
#

set -euo pipefail

# Colors
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

readonly BASE_URL="https://docs.claude.com/en/docs/claude-code"
readonly DOCS_DIR="$(dirname "$0")/downloaded-organized"
readonly SCRIPT_DIR="$(dirname "$0")"

total_files=0
successful_downloads=0
failed_downloads=0

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude Code Documentation Downloader (Organized)         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Step 1: Scrape navigation for categories
echo -e "${YELLOW}📡 Step 1: Scraping navigation structure...${NC}"
cd "$SCRIPT_DIR"
if python3 scrape-navigation.py > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Navigation scraped successfully${NC}"
else
    echo -e "${RED}✗ Failed to scrape navigation${NC}"
    exit 1
fi
echo ""

# Step 2: Verify against llms.txt
echo -e "${YELLOW}🔍 Step 2: Verifying against llms.txt...${NC}"
llms_files=$(curl -s https://docs.claude.com/llms.txt | grep -oP 'en/docs/claude-code/\K[^)]+\.md' | sort -u)
llms_count=$(echo "$llms_files" | wc -l)
echo -e "${CYAN}Found ${llms_count} files in llms.txt${NC}"
echo ""

# Step 3: Create directory structure
echo -e "${YELLOW}📁 Step 3: Creating directory structure...${NC}"
mkdir -p "$DOCS_DIR"

# Read categories from scraped JSON
categories=$(jq -r 'keys[]' scraped-navigation.json)
for category in $categories; do
    mkdir -p "$DOCS_DIR/$category"
    count=$(jq -r ".[\"$category\"] | length" scraped-navigation.json)
    echo -e "  ${CYAN}• ${category}${NC} (${count} files)"
done

# Create uncategorized folder for files not in navigation
mkdir -p "$DOCS_DIR/uncategorized"
echo -e "  ${CYAN}• uncategorized${NC} (for files not in sidebar)"
echo ""

# Step 4: Download files
echo -e "${YELLOW}⬇️  Step 4: Downloading files...${NC}"
echo ""

current=0

# Download categorized files
for category in $categories; do
    echo -e "${CYAN}━━━ $(echo $category | tr '-' ' ' | sed 's/\b\w/\U&/g') ━━━${NC}"

    files=$(jq -r ".[\"$category\"][]" scraped-navigation.json)

    for file in $files; do
        ((current++)) || true
        ((total_files++)) || true

        url="$BASE_URL/$file"
        output_path="$DOCS_DIR/$category/$(basename "$file")"

        printf "${BLUE}[%3d]${NC} %-45s " "$current" "$(basename "$file")"

        if curl -sSf "$url" -o "$output_path" 2>/dev/null; then
            file_size=$(du -h "$output_path" | cut -f1)
            echo -e "${GREEN}✓${NC} (${file_size})"
            ((successful_downloads++)) || true
        else
            echo -e "${RED}✗ Failed${NC}"
            ((failed_downloads++)) || true
            rm -f "$output_path" 2>/dev/null || true
        fi
    done
    echo ""
done

# Download uncategorized files (in llms.txt but not in navigation)
echo -e "${CYAN}━━━ Uncategorized (Not In Sidebar) ━━━${NC}"
while IFS= read -r file; do
    # Check if file is NOT in scraped navigation
    if ! jq -e --arg file "$file" '.[][] | select(. == $file)' scraped-navigation.json > /dev/null 2>&1; then
        ((current++)) || true
        ((total_files++)) || true

        url="$BASE_URL/$file"
        # Preserve directory structure for nested files
        output_path="$DOCS_DIR/uncategorized/$file"
        mkdir -p "$(dirname "$output_path")"

        printf "${BLUE}[%3d]${NC} %-45s " "$current" "$file"

        if curl -sSf "$url" -o "$output_path" 2>/dev/null; then
            file_size=$(du -h "$output_path" | cut -f1)
            echo -e "${GREEN}✓${NC} (${file_size})"
            ((successful_downloads++)) || true
        else
            echo -e "${RED}✗ Failed${NC}"
            ((failed_downloads++)) || true
            rm -f "$output_path" 2>/dev/null || true
        fi
    fi
done <<< "$llms_files"
echo ""

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Download Summary                                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e "${GREEN}✓ Successful: ${successful_downloads}/${total_files}${NC}"
if [[ $failed_downloads -gt 0 ]]; then
    echo -e "${RED}✗ Failed: ${failed_downloads}${NC}"
fi
echo -e "${BLUE}📁 Output: ${DOCS_DIR}${NC}"
echo ""

total_size=$(du -sh "$DOCS_DIR" 2>/dev/null | cut -f1 || echo "0")
echo -e "${GREEN}Total size: ${total_size}${NC}"
echo ""

# Create indexes
echo -e "${YELLOW}📝 Creating index files...${NC}"

# Main index
cat > "$DOCS_DIR/INDEX.md" <<EOF
# Claude Code Documentation

Downloaded on: $(date '+%Y-%m-%d %H:%M:%S')
Total files: $successful_downloads

## Categories

EOF

for category in $categories; do
    cat_name=$(echo $category | sed 's/-/ /g' | sed 's/\b\w/\U&/g')
    echo "### $cat_name" >> "$DOCS_DIR/INDEX.md"
    echo "" >> "$DOCS_DIR/INDEX.md"

    # Create category README
    echo "# $cat_name" > "$DOCS_DIR/$category/README.md"
    echo "" >> "$DOCS_DIR/$category/README.md"

    jq -r ".[\"$category\"][]" scraped-navigation.json | while read -r file; do
        basename_file=$(basename "$file")
        if [ -f "$DOCS_DIR/$category/$basename_file" ]; then
            title=$(grep -m 1 "^# " "$DOCS_DIR/$category/$basename_file" 2>/dev/null | sed 's/^# //' || echo "$basename_file")
            echo "- [$title](./$category/$basename_file)" >> "$DOCS_DIR/INDEX.md"
            echo "- [$title](./$basename_file)" >> "$DOCS_DIR/$category/README.md"
        fi
    done
    echo "" >> "$DOCS_DIR/INDEX.md"
done

# Uncategorized section
if [ -d "$DOCS_DIR/uncategorized" ] && [ "$(ls -A "$DOCS_DIR/uncategorized")" ]; then
    echo "### Uncategorized" >> "$DOCS_DIR/INDEX.md"
    echo "" >> "$DOCS_DIR/INDEX.md"

    find "$DOCS_DIR/uncategorized" -name "*.md" -type f | while read -r file; do
        rel_path=$(realpath --relative-to="$DOCS_DIR" "$file")
        basename_file=$(basename "$file")
        title=$(grep -m 1 "^# " "$file" 2>/dev/null | sed 's/^# //' || echo "$basename_file")
        echo "- [$title](./$rel_path)" >> "$DOCS_DIR/INDEX.md"
    done
    echo "" >> "$DOCS_DIR/INDEX.md"
fi

echo -e "${GREEN}✓ Created INDEX.md and category READMEs${NC}"
echo ""
echo -e "${GREEN}All done! 🎉${NC}"
