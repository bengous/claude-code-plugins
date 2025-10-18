#!/usr/bin/env bash
#
# download-docs.sh
# Reusable script to download Claude documentation with language and category filters
#

set -euo pipefail

# Colors
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

# Defaults
LANGUAGE="en"
CATEGORY=""
OUTPUT_DIR="./downloaded"
SCRAPE_NAV=true

# Usage
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Download Claude documentation organized by website structure.

OPTIONS:
    -l, --language LANG     Language code (default: en)
                           Available: en, de, es, fr, id, it, ja, ko, pt, ru
    -c, --category CAT     Category to download (default: all)
                           Available: claude-code, api, build-with-claude,
                                     about-claude, agents-and-tools, etc.
    -o, --output DIR       Output directory (default: ./downloaded)
    --no-scrape           Skip navigation scraping (use llms.txt only)
    --list-languages      List available languages and exit
    --list-categories     List available categories and exit
    -h, --help            Show this help message

EXAMPLES:
    # Download all English Claude Code docs
    $0 -l en -c claude-code

    # Download all German API docs
    $0 -l de -c api

    # Download all English docs (all categories)
    $0 -l en

    # List available options
    $0 --list-languages
    $0 --list-categories

EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -l|--language)
            LANGUAGE="$2"
            shift 2
            ;;
        -c|--category)
            CATEGORY="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --no-scrape)
            SCRAPE_NAV=false
            shift
            ;;
        --list-languages)
            python3 "$(dirname "$0")/parse-llms-txt.py" --list-languages
            exit 0
            ;;
        --list-categories)
            python3 "$(dirname "$0")/parse-llms-txt.py" --list-categories
            exit 0
            ;;
        -h|--help)
            usage
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Capture scrape start time for metadata
readonly SCRAPE_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
readonly SCRAPER_VERSION="1.1.0"

# Determine actual output directory
if [[ -n "$CATEGORY" ]]; then
    ACTUAL_OUTPUT="$OUTPUT_DIR/$CATEGORY/$LANGUAGE"
else
    ACTUAL_OUTPUT="$OUTPUT_DIR/$LANGUAGE"
fi

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Claude Documentation Downloader                          ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Configuration:${NC}"
echo -e "  Language: ${YELLOW}${LANGUAGE}${NC}"
echo -e "  Category: ${YELLOW}${CATEGORY:-all}${NC}"
echo -e "  Output: ${YELLOW}${ACTUAL_OUTPUT}${NC}"
echo ""

# Build filter arguments
FILTER_ARGS="-l $LANGUAGE"
if [[ -n "$CATEGORY" ]]; then
    FILTER_ARGS="$FILTER_ARGS -c $CATEGORY"
fi

# Step 1: Parse llms.txt with filters
echo -e "${YELLOW}📡 Step 1: Fetching file list from llms.txt...${NC}"
LLMS_JSON=$(python3 parse-llms-txt.py $FILTER_ARGS --format json)
FILE_COUNT=$(echo "$LLMS_JSON" | jq 'length')

if [[ "$FILE_COUNT" -eq 0 ]]; then
    echo -e "${RED}✗ No files found for language '$LANGUAGE' and category '$CATEGORY'${NC}"
    exit 1
fi

# Also fetch raw llms.txt for reference
LLMS_RAW=$(curl -sSf "https://docs.claude.com/llms.txt")

echo -e "${GREEN}✓ Found ${FILE_COUNT} files${NC}"
echo ""

# Step 2: Scrape navigation (if enabled and category is specified)
SCRAPED_NAV=""
NAV_TEMP_FILE=$(mktemp)
METADATA_FILE=""

if [[ "$SCRAPE_NAV" == true && -n "$CATEGORY" ]]; then
    echo -e "${YELLOW}📊 Step 2: Scraping navigation structure...${NC}"

    # Construct the category overview URL
    NAV_URL="https://docs.claude.com/${LANGUAGE}/docs/${CATEGORY}/overview"

    # Create output directory early for metadata
    mkdir -p "$ACTUAL_OUTPUT"
    METADATA_FILE="$ACTUAL_OUTPUT/.metadata.json"

    # Check if we can scrape this category (check for 200 status code)
    if curl -sI "$NAV_URL" 2>&1 | grep -qE "HTTP/[0-9.]+ 200"; then
        if python3 scrape-navigation.py -l "$LANGUAGE" -c "$CATEGORY" -o "$NAV_TEMP_FILE" --silent 2>/dev/null; then
            SCRAPED_NAV="$NAV_TEMP_FILE"
            echo -e "${GREEN}✓ Navigation structure extracted${NC}"
        else
            echo -e "${YELLOW}⚠ Could not scrape navigation, will use flat structure${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ Category doesn't have sidebar navigation, using flat structure${NC}"
    fi
    echo ""
fi

# Step 3: Create directory structure
echo -e "${YELLOW}📁 Step 3: Creating directory structure...${NC}"
mkdir -p "$ACTUAL_OUTPUT"

# Create temporary file for category name mapping
CATEGORY_MAPPING=$(mktemp)
trap "rm -f $CATEGORY_MAPPING $NAV_TEMP_FILE" EXIT

if [[ -n "$SCRAPED_NAV" && -f "$SCRAPED_NAV" ]]; then
    # Create categorized folders from scraped navigation with numeric prefixes
    # Use keys_unsorted to preserve website navigation order
    categories=$(jq -r 'keys_unsorted[]' "$SCRAPED_NAV")
    index=1
    for cat in $categories; do
        # Create numbered folder name (01-, 02-, etc.)
        numbered_cat=$(printf "%02d-%s" "$index" "$cat")
        echo "$cat=$numbered_cat" >> "$CATEGORY_MAPPING"

        mkdir -p "$ACTUAL_OUTPUT/$numbered_cat"
        count=$(jq -r ".[\"$cat\"] | length" "$SCRAPED_NAV")
        echo -e "  ${CYAN}• ${numbered_cat}${NC} (${count} files)"
        ((index++))
    done
    mkdir -p "$ACTUAL_OUTPUT/99-uncategorized"
    echo -e "  ${CYAN}• 99-uncategorized${NC} (for unlisted files)"
else
    # No navigation scraped - use flat structure
    echo -e "  ${CYAN}• ${ACTUAL_OUTPUT}${NC} (${FILE_COUNT} files, flat structure)"
fi

# Save raw llms.txt for reference
echo "$LLMS_RAW" > "$ACTUAL_OUTPUT/llms.txt"

echo ""

# Step 4: Download files
echo -e "${YELLOW}⬇️  Step 4: Downloading files...${NC}"
echo ""

total_files=0
successful_downloads=0
failed_downloads=0

# Process each file from llms.txt using process substitution to avoid subshell
while IFS= read -r item; do
    url=$(echo "$item" | jq -r '.url')
    file_path=$(echo "$item" | jq -r '.file_path')
    title=$(echo "$item" | jq -r '.title')
    file_cat=$(echo "$item" | jq -r '.category')

    ((total_files++)) || true

    # Determine output path
    if [[ -n "$SCRAPED_NAV" && -f "$SCRAPED_NAV" ]]; then
        # Check if file is in scraped navigation (take first match if file is in multiple categories)
        nav_category=$(jq -r --arg file "$file_path" '
            [to_entries[] | select(.value[] == $file) | .key] | first // empty
        ' "$SCRAPED_NAV" 2>/dev/null || echo "")

        if [[ -n "$nav_category" ]]; then
            # Look up numbered folder name from mapping file
            numbered_folder=$(grep "^${nav_category}=" "$CATEGORY_MAPPING" | cut -d'=' -f2)

            # Find file index within category to preserve navigation order
            file_index=$(jq -r --arg cat "$nav_category" --arg file "$file_path" '
                .[$cat] as $files |
                ($files | index($file)) + 1
            ' "$SCRAPED_NAV" 2>/dev/null)

            if [[ -n "$file_index" && "$file_index" != "null" ]]; then
                # Prefix filename with its navigation order
                numbered_filename=$(printf "%02d-%s" "$file_index" "$(basename "$file_path")")
                output_path="$ACTUAL_OUTPUT/$numbered_folder/$numbered_filename"
            else
                # Fallback if index not found
                output_path="$ACTUAL_OUTPUT/$numbered_folder/$(basename "$file_path")"
            fi
        else
            output_path="$ACTUAL_OUTPUT/99-uncategorized/$file_path"
            mkdir -p "$(dirname "$output_path")"
        fi
    else
        # Use flat structure
        output_path="$ACTUAL_OUTPUT/$file_path"
        mkdir -p "$(dirname "$output_path")"
    fi

    printf "${BLUE}[%3d/%3d]${NC} %-50s " "$total_files" "$FILE_COUNT" "$(basename "$file_path")"

    if curl -sSf "$url" -o "$output_path" 2>/dev/null; then
        file_size=$(du -h "$output_path" | cut -f1)
        echo -e "${GREEN}✓${NC} (${file_size})"
        ((successful_downloads++)) || true
    else
        echo -e "${RED}✗ Failed${NC}"
        ((failed_downloads++)) || true
        rm -f "$output_path" 2>/dev/null || true
    fi
done < <(echo "$LLMS_JSON" | jq -c '.[]')

echo ""

# Generate comprehensive metadata with scrape info, stats, and navigation
if [[ -n "$CATEGORY" ]]; then
    # Get final stats
    TOTAL_SIZE=$(du -sh "$ACTUAL_OUTPUT" 2>/dev/null | cut -f1 || echo "0")

    # Build metadata JSON
    cat > "$METADATA_FILE" <<EOF
{
  "scrape_info": {
    "timestamp": "$SCRAPE_START",
    "language": "$LANGUAGE",
    "category": "${CATEGORY}",
    "source_url": "https://docs.claude.com/${LANGUAGE}/docs/${CATEGORY}/overview",
    "scraper_version": "$SCRAPER_VERSION"
  },
  "stats": {
    "total_files": $FILE_COUNT,
    "successful": $successful_downloads,
    "failed": $failed_downloads,
    "total_size": "$TOTAL_SIZE"
  },
  "navigation": $(cat "$SCRAPED_NAV" 2>/dev/null || echo '{}')
}
EOF
fi

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Download Summary                                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e "${GREEN}✓ Successful: ${successful_downloads}/${FILE_COUNT}${NC}"
if [[ $failed_downloads -gt 0 ]]; then
    echo -e "${RED}✗ Failed: ${failed_downloads}${NC}"
fi
echo -e "${BLUE}📁 Output: ${ACTUAL_OUTPUT}${NC}"
echo ""

if [[ -d "$ACTUAL_OUTPUT" ]]; then
    total_size=$(du -sh "$ACTUAL_OUTPUT" 2>/dev/null | cut -f1 || echo "0")
    echo -e "${GREEN}Total size: ${total_size}${NC}"
fi

echo ""
echo -e "${GREEN}All done! 🎉${NC}"
