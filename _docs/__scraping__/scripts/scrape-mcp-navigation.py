#!/usr/bin/env python3
"""
Scrape navigation structure from Model Context Protocol documentation website.
Extracts 3-level hierarchy: sections → subsections → pages.
"""

import re
import json
import sys
import argparse
import urllib.request
from html.parser import HTMLParser

class MCPNavParser(HTMLParser):
    def __init__(self, section_name):
        super().__init__()
        self.section_name = section_name
        self.in_nav = False
        self.in_subsection_header = False
        self.in_sidebar_title = False
        self.in_sidebar_group = False
        self.in_collapsible = False
        self.current_subsection = None
        self.subsections = {}
        self.subsection_order = []
        self.top_level_pages = []
        self.current_tag_is_link = False
        self.current_attrs = {}

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)

        # Detect navigation section
        if tag == 'div' and attrs_dict.get('id') == 'navigation-items':
            self.in_nav = True

        # Detect subsection header
        if self.in_nav and tag == 'div' and 'sidebar-group-header' in attrs_dict.get('class', ''):
            self.in_subsection_header = True

        # Detect subsection title
        if self.in_subsection_header and tag == 'h5' and attrs_dict.get('id') == 'sidebar-title':
            self.in_sidebar_title = True

        # Detect sidebar group (list of pages)
        if self.in_nav and tag == 'ul' and attrs_dict.get('id') == 'sidebar-group':
            self.in_sidebar_group = True

        # Detect collapsible section
        if self.in_nav and tag == 'button' and 'Toggle' in attrs_dict.get('aria-label', ''):
            self.in_collapsible = True
            # Also capture the button text as the next subsection name
            # It will be captured in handle_data

        # Detect links to documentation pages
        if self.in_nav and tag == 'a' and 'href' in attrs_dict:
            self.current_tag_is_link = True
            self.current_attrs = attrs_dict

        # Detect collapsible subsection list (nested ul inside collapsible li)
        if self.in_nav and tag == 'ul' and 'space-y-px' in attrs_dict.get('class', ''):
            # This is a nested list, likely utilities or similar
            self.in_sidebar_group = True

    def handle_data(self, data):
        # Capture subsection name from header or from collapsible button
        if self.in_sidebar_title or self.in_collapsible:
            subsection_name = data.strip()
            if subsection_name and subsection_name != '\u200b':  # Ignore zero-width spaces
                # Convert to kebab-case key
                subsection_key = subsection_name.lower().replace(' ', '-').replace('  ', ' ')

                # For collapsible sections, create a nested subsection
                if self.current_subsection and self.in_collapsible:
                    # This is a nested subsection (e.g., "base-protocol/utilities")
                    nested_key = f'{self.current_subsection}/{subsection_key}'
                    if nested_key not in self.subsections:
                        self.subsections[nested_key] = []
                        self.subsection_order.append(nested_key)
                    self.current_subsection = nested_key
                else:
                    # Top-level subsection
                    self.current_subsection = subsection_key
                    if subsection_key not in self.subsections:
                        self.subsections[subsection_key] = []
                        self.subsection_order.append(subsection_key)

        # Capture link text and href for pages
        if self.current_tag_is_link:
            href = self.current_attrs.get('href', '')
            page_title = data.strip()

            # Debug utilities
            if 'utilities' in href.lower():
                print(f"DEBUG LINK: href={href}, title={page_title}, in_sidebar_group={self.in_sidebar_group}, current_subsection={self.current_subsection}", file=sys.stderr)

            # Filter out noise: anchors, empty titles, external links, zero-width spaces
            if not href or not page_title or page_title == '\u200b':
                return
            if href.startswith('#') or href.startswith('http'):
                return

            # Must be a path starting with /
            if not href.startswith('/'):
                return

            if href and page_title:
                # Determine if this is a top-level page or belongs to a subsection
                # Top-level pages are in sidebar-group but not under a subsection header
                if self.in_sidebar_group and self.current_subsection:
                    # Page belongs to current subsection
                    page_data = {
                        'title': page_title,
                        'path': href
                    }
                    # Debug: print when adding utilities
                    if 'utilities' in href.lower():
                        print(f"DEBUG: Adding {page_title} to {self.current_subsection}, in_sidebar_group={self.in_sidebar_group}", file=sys.stderr)

                    # Check for duplicates by path
                    if self.current_subsection in self.subsections and not any(p['path'] == href for p in self.subsections[self.current_subsection]):
                        self.subsections[self.current_subsection].append(page_data)
                    elif self.current_subsection not in self.subsections:
                        print(f"DEBUG: subsection '{self.current_subsection}' not in subsections dict!", file=sys.stderr)
                elif self.in_nav and not self.in_subsection_header and not self.current_subsection:
                    # Top-level page (no subsection) - only before any subsection is defined
                    page_data = {
                        'title': page_title,
                        'path': href
                    }
                    # Check for duplicates by path
                    if not any(p['path'] == href for p in self.top_level_pages):
                        self.top_level_pages.append(page_data)

    def handle_endtag(self, tag):
        if tag == 'a':
            self.current_tag_is_link = False
            self.current_attrs = {}

        if tag == 'h5' and self.in_sidebar_title:
            self.in_sidebar_title = False

        if tag == 'div' and self.in_subsection_header:
            self.in_subsection_header = False
            # Don't reset current_subsection - it applies to following pages

        if tag == 'ul' and self.in_sidebar_group:
            self.in_sidebar_group = False

        # DON'T reset in_collapsible on button end - wait for the li to end
        # if tag == 'button' and self.in_collapsible:
        #     self.in_collapsible = False

        # Reset collapsible when the containing li ends
        if tag == 'li' and self.in_collapsible:
            self.in_collapsible = False

        # Reset current subsection when we hit the next subsection header
        if tag == 'div' and 'mt-6' in str(self.get_starttag_text() if hasattr(self, 'get_starttag_text') else ''):
            self.current_subsection = None

def scrape_section(url, section_name):
    """Fetch and parse navigation structure for one section."""
    print(f"🔍 Fetching {section_name}: {url}...", flush=True, file=sys.stderr)
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'}
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            html = response.read().decode('utf-8')
    except Exception as e:
        print(f"✗ Failed to fetch {section_name}: {e}", file=sys.stderr)
        return None

    print(f"📊 Parsing {section_name} navigation...", flush=True, file=sys.stderr)
    parser = MCPNavParser(section_name)
    parser.feed(html)

    # Build result structure
    result = {
        'top_level': parser.top_level_pages,
        'subsections': {}
    }

    for subsection in parser.subsection_order:
        result['subsections'][subsection] = parser.subsections[subsection]

    return result

def scrape_all_sections():
    """Scrape all 4 main sections of MCP documentation."""
    sections = {
        'documentation': 'https://modelcontextprotocol.io/docs/getting-started/intro',
        'specification': 'https://modelcontextprotocol.io/specification/2025-06-18',
        'community': 'https://modelcontextprotocol.io/community/communication',
        'about': 'https://modelcontextprotocol.io/about'
    }

    navigation = {}

    for section_name, url in sections.items():
        result = scrape_section(url, section_name)
        if result:
            navigation[section_name] = result
        else:
            print(f"⚠️  Warning: Failed to scrape {section_name}", file=sys.stderr)

    return navigation

def main():
    parser = argparse.ArgumentParser(
        description='Scrape navigation structure from MCP documentation'
    )
    parser.add_argument(
        '-s', '--section',
        help='Scrape specific section only (documentation, specification, community, about)',
        default=None
    )
    parser.add_argument(
        '-u', '--url',
        help='Custom URL to scrape (requires --section)',
        default=None
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

    # Scrape navigation
    if args.section and args.url:
        # Scrape single section with custom URL
        navigation = {args.section: scrape_section(args.url, args.section)}
    elif args.section:
        print("✗ Error: --url is required when using --section", file=sys.stderr)
        sys.exit(1)
    else:
        # Scrape all sections
        navigation = scrape_all_sections()

    if not navigation:
        print("✗ Failed to scrape any sections", file=sys.stderr)
        sys.exit(1)

    if not args.silent:
        print("\n✅ Navigation structure extracted!", file=sys.stderr)
        print(f"Scraped {len(navigation)} main sections:\n", file=sys.stderr)

        for section_name, section_data in navigation.items():
            if section_data:
                top_level_count = len(section_data.get('top_level', []))
                subsection_count = len(section_data.get('subsections', {}))
                total_pages = top_level_count
                for pages in section_data.get('subsections', {}).values():
                    total_pages += len(pages)
                print(f"  • {section_name}: {total_pages} pages ({subsection_count} subsections)", file=sys.stderr)

    # Save or print
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(navigation, f, indent=2)
        if not args.silent:
            print(f"\n💾 Saved to: {args.output}", file=sys.stderr)
    else:
        # Print to stdout for piping
        print(json.dumps(navigation, indent=2))

if __name__ == '__main__':
    main()
