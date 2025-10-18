#!/usr/bin/env python3
"""
Parse llms.txt from Model Context Protocol documentation.
Simpler than Claude parser - no language/category filtering needed.
"""

import re
import json
import urllib.request
import argparse
import sys

def fetch_llms_txt(url='https://modelcontextprotocol.io/llms.txt'):
    """Fetch the llms.txt file from MCP docs."""
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    with urllib.request.urlopen(req, timeout=30) as response:
        return response.read().decode('utf-8')

def parse_llms_txt(content):
    """
    Parse MCP llms.txt and extract structured data.

    Format: - [Title](URL): Description
    Example: - [What is MCP?](https://modelcontextprotocol.io/docs/getting-started/intro): Introduction

    Returns:
        list: [
            {
                'title': 'What is MCP?',
                'url': 'https://modelcontextprotocol.io/docs/getting-started/intro',
                'path': '/docs/getting-started/intro',
                'description': 'Introduction',
                'file_name': 'intro.md'
            },
            ...
        ]
    """
    results = []

    # Pattern: - [Title](URL): Description
    # Matches: - [Text](https://modelcontextprotocol.io/path/to/page): Description text
    pattern = r'-\s+\[([^\]]+)\]\((https://modelcontextprotocol\.io([^)]+))\)(?::\s+(.+))?'

    for match in re.finditer(pattern, content):
        title = match.group(1).strip()
        full_url = match.group(2).strip()
        path = match.group(3).strip()
        description = match.group(4).strip() if match.group(4) else ''

        # Skip if no URL path (header lines, etc.)
        if not path:
            continue

        # Derive file name from path
        file_name = path.split('/')[-1]
        if not file_name.endswith('.md'):
            file_name += '.md'

        results.append({
            'title': title,
            'url': full_url,
            'path': path,
            'description': description,
            'file_name': file_name
        })

    return results

def main():
    parser = argparse.ArgumentParser(
        description='Parse llms.txt from MCP documentation'
    )
    parser.add_argument(
        'url',
        nargs='?',
        default='https://modelcontextprotocol.io/llms.txt',
        help='URL to llms.txt (default: MCP docs)'
    )
    parser.add_argument(
        '-o', '--output',
        help='Output file for JSON results',
        default=None
    )
    parser.add_argument(
        '--format',
        choices=['json', 'urls', 'paths'],
        default='json',
        help='Output format: json (full data), urls (just URLs), paths (just paths)'
    )
    parser.add_argument(
        '--silent',
        action='store_true',
        help='Only output data, no status messages'
    )

    args = parser.parse_args()

    if not args.silent:
        print(f"🔍 Fetching llms.txt from {args.url}...", flush=True, file=sys.stderr)

    content = fetch_llms_txt(args.url)

    if not args.silent:
        print("📊 Parsing file list...", flush=True, file=sys.stderr)

    results = parse_llms_txt(content)

    if not args.silent:
        print(f"\n✅ Found {len(results)} files\n", file=sys.stderr)

    # Format output
    if args.format == 'urls':
        output = [item['url'] for item in results]
    elif args.format == 'paths':
        output = [item['path'] for item in results]
    else:  # json
        output = results

    # Save or print
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(output, f, indent=2)
        if not args.silent:
            print(f"💾 Saved to: {args.output}", file=sys.stderr)
    else:
        print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
