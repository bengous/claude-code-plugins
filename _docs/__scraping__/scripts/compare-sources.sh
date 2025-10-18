#!/bin/bash
# Compare scraped navigation with llms.txt to find discrepancies

echo "Comparing sources..."

# Extract files from scraped navigation
scraped=$(jq -r '.[][] | select(. != null)' scraped-navigation.json | sed 's|sdk/||' | sort -u)

# Extract files from llms.txt
from_llms=$(curl -s https://docs.claude.com/llms.txt | grep -oP 'claude-code/\K[^)]+\.md' | sort -u)

echo "Files in scraped navigation:"
echo "$scraped" | wc -l

echo "Files in llms.txt:"
echo "$from_llms" | wc -l

echo -e "\nIn llms.txt but NOT in scraped navigation:"
comm -13 <(echo "$scraped") <(echo "$from_llms")

echo -e "\nIn scraped navigation but NOT in llms.txt:"
comm -23 <(echo "$scraped") <(echo "$from_llms")
