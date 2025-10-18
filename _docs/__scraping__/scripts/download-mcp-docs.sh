#!/usr/bin/env bash
#
# download-mcp-docs.sh
# Download Model Context Protocol documentation with navigation-based folder structure
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
OUTPUT_DIR="./downloaded/mcp"

# Usage
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Download Model Context Protocol documentation with navigation structure.

OPTIONS:
    -o, --output DIR       Output directory (default: ./downloaded/mcp)
    -h, --help            Show this help message

EXAMPLES:
    # Download all MCP docs
    $0

    # Specify output directory
    $0 -o ../../scraped/mcp

EOF
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
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

# Capture scrape start time
readonly SCRAPE_START=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
readonly SCRAPER_VERSION="1.1.0"

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   MCP Documentation Downloader                             ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${CYAN}Output: ${YELLOW}${OUTPUT_DIR}${NC}"
echo ""

# Step 1: Scrape navigation
echo -e "${YELLOW}📊 Step 1: Scraping navigation structure...${NC}"
NAV_FILE=$(mktemp)
trap "rm -f $NAV_FILE" EXIT

if ! python3 scrape-mcp-navigation.py -o "$NAV_FILE" --silent 2>/dev/null; then
    echo -e "${RED}✗ Failed to scrape navigation${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Navigation structure extracted${NC}"
echo ""

# Step 2: Parse llms.txt
echo -e "${YELLOW}📡 Step 2: Fetching file list from llms.txt...${NC}"
LLMS_JSON=$(python3 parse-mcp-llms.py --format json --silent)
FILE_COUNT=$(echo "$LLMS_JSON" | jq 'length')

# Also fetch raw llms.txt for reference
LLMS_RAW=$(curl -sSf "https://modelcontextprotocol.io/llms.txt")

echo -e "${GREEN}✓ Found ${FILE_COUNT} files${NC}"
echo ""

# Step 3: Build path mapping using Python
echo -e "${YELLOW}🗺️  Step 3: Building navigation-based path mapping...${NC}"

PATH_MAP=$(python3 -c "
import json
import sys

# Load navigation structure
with open('$NAV_FILE', 'r') as f:
    nav = json.load(f)

# Load llms.txt file list
llms_files = json.loads('''$LLMS_JSON''')

# Section names and numbering
section_map = {
    'documentation': ('01-documentation', 1),
    'specification': ('02-specification', 2),
    'community': ('03-community', 3),
    'about': ('04-about-mcp', 4)
}

path_mapping = {}

# Build path mapping for each section
for section_key, section_data in nav.items():
    if section_key not in section_map:
        continue

    section_folder, _ = section_map[section_key]
    subsection_order = list(section_data.get('subsections', {}).keys())
    top_level = section_data.get('top_level', [])

    # Map top-level pages (no subsection)
    for idx, page in enumerate(top_level, 1):
        nav_path = page['path']
        filename = nav_path.split('/')[-1] if '/' in nav_path else 'index'

        # Top-level files go directly in section folder with numbering
        numbered_filename = f'{idx:02d}-{filename}.md'
        output_path = f'{section_folder}/{numbered_filename}'

        # Map both with and without .md extension
        path_mapping[nav_path] = output_path
        path_mapping[nav_path + '.md'] = output_path
        if not nav_path.endswith('/'):
            path_mapping[nav_path + '/'] = output_path

    # Map subsection pages
    for sub_idx, subsection_key in enumerate(subsection_order, 1):
        subsection_pages = section_data['subsections'][subsection_key]

        # Handle nested subsections (e.g., "base-protocol/utilities")
        if '/' in subsection_key:
            parts = subsection_key.split('/')
            # Find parent subsection index
            parent_key = parts[0]
            nested_key = parts[1]

            parent_idx = subsection_order.index(parent_key) + 1 if parent_key in subsection_order else sub_idx
            parent_folder = f'{parent_idx:02d}-{parent_key}'

            # Calculate nested folder number (count previous nested in same parent)
            nested_count = sum(1 for k in subsection_order[:sub_idx] if k.startswith(parent_key + '/') and k != subsection_key)
            # Add to parent's child count (5 regular pages + nested folders)
            regular_pages_count = len(section_data['subsections'].get(parent_key, []))
            nested_idx = regular_pages_count + nested_count + 1

            subsection_folder = f'{parent_folder}/{nested_idx:02d}-{nested_key}'
        else:
            subsection_folder = f'{sub_idx:02d}-{subsection_key}'

        for page_idx, page in enumerate(subsection_pages, 1):
            nav_path = page['path']

            # Extract filename from path
            filename = nav_path.split('/')[-1] if '/' in nav_path else 'index'

            # Build numbered output path
            numbered_filename = f'{page_idx:02d}-{filename}.md'
            output_path = f'{section_folder}/{subsection_folder}/{numbered_filename}'

            # Map both with and without .md extension
            path_mapping[nav_path] = output_path
            path_mapping[nav_path + '.md'] = output_path
            if not nav_path.endswith('/'):
                path_mapping[nav_path + '/'] = output_path

# Output mapping as JSON
print(json.dumps(path_mapping, indent=2))
")

echo -e "${GREEN}✓ Path mapping generated${NC}"
echo ""

# Step 4: Create directory structure based on mapping
echo -e "${YELLOW}📁 Step 4: Creating directory structure...${NC}"
mkdir -p "$OUTPUT_DIR"

# Extract all directory paths from mapping and create them
echo "$PATH_MAP" | jq -r '.[]' | while read -r output_path; do
    mkdir -p "$OUTPUT_DIR/$(dirname "$output_path")"
done

# Create additional directories for manually mapped paths
mkdir -p "$OUTPUT_DIR/02-specification/01-base-protocol/06-utilities"
mkdir -p "$OUTPUT_DIR/02-specification/04-server-features/05-utilities"

# Save raw llms.txt for reference
echo "$LLMS_RAW" > "$OUTPUT_DIR/llms.txt"

echo -e "${GREEN}✓ Directory structure created${NC}"
echo ""

# Step 5: Download files
echo -e "${YELLOW}⬇️  Step 5: Downloading files to numbered paths...${NC}"
echo ""

total_files=0
successful_downloads=0
failed_downloads=0

# Save JSON to temp file for processing
LLMS_FILE=$(mktemp)
echo "$LLMS_JSON" > "$LLMS_FILE"

# Download each file to its mapped location
while IFS= read -r item; do
    url=$(echo "$item" | jq -r '.url')
    path=$(echo "$item" | jq -r '.path')
    title=$(echo "$item" | jq -r '.title')

    total_files=$((total_files + 1))

    # Look up the mapped output path
    output_path=$(echo "$PATH_MAP" | jq -r --arg p "$path" '.[$p] // empty')

    # If not found and path ends with /index.md, try without it
    if [[ -z "$output_path" ]] && [[ "$path" == */index.md ]]; then
        dir_path="${path%/index.md}"
        output_path=$(echo "$PATH_MAP" | jq -r --arg p "$dir_path" '.[$p] // empty')
        if [[ -n "$output_path" ]]; then
            # Add back the index.md filename to the output path
            output_path="${output_path%.md}-index.md"
        fi
    fi

    # Manual mappings for known unmapped paths
    if [[ -z "$output_path" ]]; then
        case "$path" in
            # Homepage
            /about/index.md)
                output_path="04-about-mcp/00-homepage.md"
                ;;
            # Base protocol utilities (missing from navigation)
            /specification/2025-06-18/basic/utilities/cancellation.md)
                output_path="02-specification/01-base-protocol/06-utilities/01-cancellation.md"
                ;;
            /specification/2025-06-18/basic/utilities/ping.md)
                output_path="02-specification/01-base-protocol/06-utilities/02-ping.md"
                ;;
            /specification/2025-06-18/basic/utilities/progress.md)
                output_path="02-specification/01-base-protocol/06-utilities/03-progress.md"
                ;;
            # Server feature utilities (missing from navigation)
            /specification/2025-06-18/server/utilities/completion.md)
                output_path="02-specification/04-server-features/05-utilities/01-completion.md"
                ;;
            /specification/2025-06-18/server/utilities/logging.md)
                output_path="02-specification/04-server-features/05-utilities/02-logging.md"
                ;;
            /specification/2025-06-18/server/utilities/pagination.md)
                output_path="02-specification/04-server-features/05-utilities/03-pagination.md"
                ;;
            # Schema (missing from navigation)
            /specification/2025-06-18/schema.md)
                output_path="02-specification/05-schema.md"
                ;;
        esac
    fi

    if [[ -z "$output_path" ]]; then
        # Fallback: if not in mapping, save to uncategorized
        filename=$(basename "$path")
        if [[ ! "$filename" =~ \.md$ ]]; then
            filename="${filename}.md"
        fi
        output_path="99-uncategorized/$filename"
        mkdir -p "$OUTPUT_DIR/99-uncategorized"
    fi

    full_output_path="$OUTPUT_DIR/$output_path"

    # Display shortened filename for progress
    display_name=$(basename "$output_path")
    printf "${BLUE}[%3d/%3d]${NC} %-50s " "$total_files" "$FILE_COUNT" "$display_name"

    if curl -sSf "$url" -o "$full_output_path" 2>/dev/null; then
        file_size=$(du -h "$full_output_path" | cut -f1)
        echo -e "${GREEN}✓${NC} → ${CYAN}${output_path}${NC}"
        successful_downloads=$((successful_downloads + 1))
    else
        echo -e "${RED}✗ Failed${NC}"
        failed_downloads=$((failed_downloads + 1))
        rm -f "$full_output_path" 2>/dev/null || true
    fi
done < <(jq -c '.[]' "$LLMS_FILE")

rm -f "$LLMS_FILE"

echo ""

# Generate metadata
METADATA_FILE="$OUTPUT_DIR/.metadata.json"
TOTAL_SIZE=$(du -sh "$OUTPUT_DIR" 2>/dev/null | cut -f1 || echo "0")

cat > "$METADATA_FILE" <<EOF
{
  "scrape_info": {
    "timestamp": "$SCRAPE_START",
    "source_url": "https://modelcontextprotocol.io",
    "scraper_version": "$SCRAPER_VERSION"
  },
  "stats": {
    "total_files": $FILE_COUNT,
    "successful": $successful_downloads,
    "failed": $failed_downloads,
    "total_size": "$TOTAL_SIZE"
  },
  "navigation": $(cat "$NAV_FILE")
}
EOF

# Summary
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Download Summary                                         ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo -e "${GREEN}✓ Successful: ${successful_downloads}/${FILE_COUNT}${NC}"
if [[ $failed_downloads -gt 0 ]]; then
    echo -e "${RED}✗ Failed: ${failed_downloads}${NC}"
fi
echo -e "${BLUE}📁 Output: ${OUTPUT_DIR}${NC}"
echo -e "${GREEN}Total size: ${TOTAL_SIZE}${NC}"
echo ""
echo -e "${GREEN}All done! 🎉${NC}"
