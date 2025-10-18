#!/usr/bin/env python3
"""
Parse llms.txt and filter by language and category.
Makes the download script reusable for any Claude documentation section.
"""

import re
import json
import urllib.request
import argparse
from collections import defaultdict

def fetch_llms_txt():
    """Fetch the llms.txt file from Claude docs."""
    url = 'https://docs.claude.com/llms.txt'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})

    with urllib.request.urlopen(req) as response:
        return response.read().decode('utf-8')

def parse_llms_txt(content):
    """
    Parse llms.txt and extract structured data.

    Returns:
        dict: {
            'by_language': {
                'en': {'claude-code': [...], 'api': [...], ...},
                'de': {...},
                ...
            },
            'all_languages': set(),
            'all_categories': set()
        }
    """
    data = defaultdict(lambda: defaultdict(list))
    all_languages = set()
    all_categories = set()

    # Pattern to match markdown links with .md extension
    # Example: [Text](https://docs.claude.com/en/docs/claude-code/overview.md)
    # Must have proper URL structure and end with .md
    pattern = r'\[([^\]]+)\]\((https://docs\.claude\.com/([a-z]{2})/docs/([a-z0-9\-]+)/([^)]+\.md))\)'

    for match in re.finditer(pattern, content):
        title = match.group(1)
        full_url = match.group(2)
        language = match.group(3)
        category = match.group(4)
        file_path = match.group(5)

        all_languages.add(language)
        all_categories.add(category)

        data[language][category].append({
            'title': title,
            'url': full_url,
            'file_path': file_path,
            'language': language,
            'category': category
        })

    return {
        'by_language': dict(data),
        'all_languages': sorted(all_languages),
        'all_categories': sorted(all_categories)
    }

def filter_by_criteria(parsed_data, language=None, category=None):
    """
    Filter parsed data by language and/or category.

    Args:
        parsed_data: Output from parse_llms_txt()
        language: Language code (e.g., 'en', 'de') or None for all
        category: Category name (e.g., 'claude-code', 'api') or None for all

    Returns:
        list: Filtered file entries
    """
    results = []

    by_lang = parsed_data['by_language']

    # Filter by language
    languages = [language] if language else parsed_data['all_languages']

    for lang in languages:
        if lang not in by_lang:
            continue

        # Filter by category
        categories = [category] if category else by_lang[lang].keys()

        for cat in categories:
            if cat not in by_lang[lang]:
                continue

            results.extend(by_lang[lang][cat])

    return results

def main():
    parser = argparse.ArgumentParser(
        description='Parse llms.txt and filter Claude documentation by language and category'
    )
    parser.add_argument(
        '-l', '--language',
        help='Language code (e.g., en, de, es, fr). Default: all languages',
        default=None
    )
    parser.add_argument(
        '-c', '--category',
        help='Category (e.g., claude-code, api, mcp). Default: all categories',
        default=None
    )
    parser.add_argument(
        '--list-languages',
        action='store_true',
        help='List all available languages and exit'
    )
    parser.add_argument(
        '--list-categories',
        action='store_true',
        help='List all available categories and exit'
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
        help='Output format: json (full data), urls (just URLs), paths (just file paths)'
    )

    args = parser.parse_args()

    import sys
    print("🔍 Fetching llms.txt...", flush=True, file=sys.stderr)
    content = fetch_llms_txt()

    print("📊 Parsing documentation structure...", flush=True, file=sys.stderr)
    parsed = parse_llms_txt(content)

    # List available options if requested
    if args.list_languages:
        print("\n📚 Available languages:")
        for lang in parsed['all_languages']:
            count = sum(len(cats) for cats in parsed['by_language'][lang].values())
            print(f"  • {lang}: {count} files")
        return

    if args.list_categories:
        print("\n📁 Available categories:")
        categories_count = defaultdict(int)
        for lang_data in parsed['by_language'].values():
            for cat, files in lang_data.items():
                categories_count[cat] += len(files)

        for cat in sorted(categories_count.keys()):
            print(f"  • {cat}: {categories_count[cat]} files")
        return

    # Filter results
    results = filter_by_criteria(parsed, args.language, args.category)

    import sys
    print(f"\n✅ Found {len(results)} files", file=sys.stderr)
    if args.language:
        print(f"   Language: {args.language}", file=sys.stderr)
    if args.category:
        print(f"   Category: {args.category}", file=sys.stderr)
    print(file=sys.stderr)

    # Format output
    if args.format == 'urls':
        output = [item['url'] for item in results]
    elif args.format == 'paths':
        output = [item['file_path'] for item in results]
    else:  # json
        output = results

    # Save or print
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(output, f, indent=2)
        import sys
        print(f"💾 Saved to: {args.output}", file=sys.stderr)
    else:
        print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
