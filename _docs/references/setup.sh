#!/usr/bin/env bash
#
# setup.sh - Clone external reference repositories
#

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m'

echo -e "${BLUE}════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  External References Setup${NC}"
echo -e "${BLUE}════════════════════════════════════════════════${NC}"
echo ""

# Anthropic Cookbook
if [[ -d "anthropic-cookbook/.git" ]]; then
    echo -e "${YELLOW}📚 Anthropic Cookbook:${NC} Already exists"
    echo -e "   To update: cd anthropic-cookbook && git pull"
else
    echo -e "${YELLOW}📚 Cloning Anthropic Cookbook...${NC}"
    if git clone https://github.com/anthropics/anthropic-cookbook.git; then
        echo -e "${GREEN}   ✓ Anthropic Cookbook cloned successfully${NC}"
    else
        echo -e "${RED}   ✗ Failed to clone Anthropic Cookbook${NC}"
    fi
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════${NC}"
echo ""
echo -e "External references are ready to use."
echo ""
