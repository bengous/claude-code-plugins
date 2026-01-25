#!/usr/bin/env bash
#
# Extract system prompts from Claude Code's cli.js using Piebald's AST extractor.
# Runs in an isolated npm environment to avoid polluting your native installation.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
OUTPUT_DIR="$REPO_ROOT/.claude-system-prompts"
TEMP_DIR=$(mktemp -d)

cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Setting up isolated environment in $TEMP_DIR..."

# 1. Install npm version of Claude Code in temp dir
cd "$TEMP_DIR"
npm init -y --quiet >/dev/null 2>&1
echo "Installing @anthropic-ai/claude-code and @babel/parser..."
npm install @anthropic-ai/claude-code @babel/parser --quiet 2>/dev/null

# Get version
VERSION=$(node -p "require('./node_modules/@anthropic-ai/claude-code/package.json').version")
echo "Claude Code version: $VERSION"

# 2. Copy vendored extractor
cp "$SCRIPT_DIR/prompt-extractor/promptExtractor.js" .

# 3. Run extraction
CLI_JS="$TEMP_DIR/node_modules/@anthropic-ai/claude-code/cli.js"
OUTPUT_FILE="$OUTPUT_DIR/prompts-$VERSION.json"

mkdir -p "$OUTPUT_DIR"

echo "Extracting prompts from cli.js..."
node promptExtractor.js "$CLI_JS" "$OUTPUT_FILE"

echo ""
echo "===== Extraction Complete ====="
echo "Output: $OUTPUT_FILE"
echo "Prompt count: $(jq '.prompts | length' "$OUTPUT_FILE")"
echo ""

# Show sample of what was extracted
echo "Sample prompts (first 3):"
jq -r '.prompts[:3][] | "  - \(.pieces[0][:80] | gsub("\n"; " "))..."' "$OUTPUT_FILE"
