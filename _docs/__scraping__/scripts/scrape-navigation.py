#!/usr/bin/env python3
"""
Scrape navigation structure from Claude documentation website.
Extracts categories and their files directly from the HTML sidebar.
"""

import re
import json
import sys
import argparse
import urllib.request
from html.parser import HTMLParser

class NavParser(HTMLParser):
    def __init__(self, language, category):
        super().__init__()
        self.language = language
        self.category = category
        self.search_pattern = f'/{language}/docs/{category}/'
        self.in_nav = False
        self.in_category_header = False
        self.in_sidebar_title = False
        self.current_category = None
        self.categories = {}
        self.category_order = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)

        # Detect navigation section
        if tag == 'div' and attrs_dict.get('id') == 'navigation-items':
            self.in_nav = True

        # Detect category header
        if self.in_nav and tag == 'div' and 'sidebar-group-header' in attrs_dict.get('class', ''):
            self.in_category_header = True

        # Detect category title
        if self.in_category_header and tag == 'h5' and attrs_dict.get('id') == 'sidebar-title':
            self.in_sidebar_title = True

        # Detect links to documentation pages
        if self.in_nav and tag == 'a' and 'href' in attrs_dict:
            href = attrs_dict['href']
            if self.search_pattern in href:
                # Extract filename from URL
                filename = href.split(f'/{self.category}/')[-1]
                # Handle nested paths (like sdk/migration-guide)
                if not filename.endswith('.md'):
                    filename += '.md'

                # Add to current category
                if self.current_category and filename not in self.categories[self.current_category]:
                    self.categories[self.current_category].append(filename)

    def handle_data(self, data):
        if self.in_sidebar_title:
            # Capture category name
            category_name = data.strip()
            if category_name:
                # Convert to kebab-case key
                category_key = category_name.lower().replace(' ', '-')
                self.current_category = category_key

                if category_key not in self.categories:
                    self.categories[category_key] = []
                    self.category_order.append(category_key)

    def handle_endtag(self, tag):
        if tag == 'h5' and self.in_sidebar_title:
            self.in_sidebar_title = False
            self.in_category_header = False
        elif tag == 'div' and self.in_nav:
            # Could be end of navigation
            pass

def scrape_navigation(url, language, category):
    """Fetch and parse navigation structure from Claude docs."""
    print(f"🔍 Fetching page: {url}...", flush=True, file=sys.stderr)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'}
    )

    try:
        with urllib.request.urlopen(req) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"✗ Failed to fetch page: {e}", file=sys.stderr)
        return None, []

    print("📊 Parsing navigation structure...", flush=True, file=sys.stderr)
    parser = NavParser(language, category)
    parser.feed(html)

    # Create ordered dict
    result = {}
    for cat in parser.category_order:
        result[cat] = parser.categories[cat]

    return result, parser.category_order

def main():
    parser = argparse.ArgumentParser(
        description='Scrape navigation structure from Claude documentation'
    )
    parser.add_argument(
        '-l', '--language',
        default='en',
        help='Language code (default: en)'
    )
    parser.add_argument(
        '-c', '--category',
        default='claude-code',
        help='Category to scrape (default: claude-code)'
    )
    parser.add_argument(
        '-u', '--url',
        help='Custom URL to scrape (overrides language/category)'
    )
    parser.add_argument(
        '-o', '--output',
        help='Output file for navigation JSON',
        default=None
    )
    parser.add_argument(
        '--silent',
        action='store_true',
        help='Only output JSON, no status messages'
    )

    args = parser.parse_args()

    # Construct URL
    if args.url:
        url = args.url
    else:
        url = f'https://docs.claude.com/{args.language}/docs/{args.category}/overview'

    # Scrape navigation
    categories, order = scrape_navigation(url, args.language, args.category)

    if categories is None:
        sys.exit(1)

    if not args.silent:
        print("\n✅ Navigation structure extracted!", file=sys.stderr)
        print(f"Found {len(categories)} categories:\n", file=sys.stderr)

        total_files = 0
        for category in order:
            files = categories[category]
            total_files += len(files)
            print(f"  • {category}: {len(files)} files", file=sys.stderr)

        print(f"\nTotal files: {total_files}\n", file=sys.stderr)

    # Save or print
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(categories, f, indent=2)
        if not args.silent:
            print(f"💾 Saved to: {args.output}", file=sys.stderr)
    else:
        # Print to stdout for piping
        print(json.dumps(categories, indent=2))

if __name__ == '__main__':
    main()
