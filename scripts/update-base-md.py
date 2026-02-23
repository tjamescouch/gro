#!/usr/bin/env python3
"""
update-base-md.py — Safe _base.md section updater for gro agents.

Purpose: Agents cannot safely write stream marker syntax (@@...@@, emoji markers)
directly into docs because the runtime intercepts their output stream. This script
runs as a subprocess, so its writes are not filtered by the agent runtime.

Usage:
    python3 scripts/update-base-md.py --file _base.md --section "Thinking Level" --content content.txt
    python3 scripts/update-base-md.py --file _base.md --section "Thinking Level" --content-stdin < content.txt
    python3 scripts/update-base-md.py --file _base.md --list-sections
    python3 scripts/update-base-md.py --file _base.md --append-after "Thinking Level" --content content.txt

The script identifies sections by heading text (##, ###) and replaces the content
between that heading and the next heading of equal or higher level.
"""

import argparse
import re
import sys
import os


def parse_sections(text):
    """Return list of (heading_line_idx, level, title, start_idx, end_idx) tuples."""
    lines = text.split('\n')
    sections = []
    heading_re = re.compile(r'^(#{1,6})\s+(.*)')
    
    for i, line in enumerate(lines):
        m = heading_re.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip()
            sections.append((i, level, title))
    
    return lines, sections


def find_section_bounds(lines, sections, target_title):
    """Find the line range for a section by title. Returns (start, end) line indices."""
    target_lower = target_title.lower()
    
    for idx, (line_idx, level, title) in enumerate(sections):
        if title.lower() == target_lower or target_lower in title.lower():
            # Section starts at line_idx, ends just before the next section of same/higher level
            end_idx = len(lines)
            for next_line_idx, next_level, _ in sections[idx + 1:]:
                if next_level <= level:
                    end_idx = next_line_idx
                    break
            return line_idx, end_idx, level
    
    return None, None, None


def list_sections(text):
    """Print all section headings."""
    lines, sections = parse_sections(text)
    for _, level, title in sections:
        indent = '  ' * (level - 1)
        print(f"{indent}{'#' * level} {title}")


def replace_section(text, target_title, new_content):
    """Replace the body of a section (keeping the heading) with new_content."""
    lines, sections = parse_sections(text)
    start, end, level = find_section_bounds(lines, sections, target_title)
    
    if start is None:
        print(f"ERROR: Section '{target_title}' not found.", file=sys.stderr)
        sys.exit(1)
    
    # Keep the heading line, replace everything until the next same-level heading
    heading_line = lines[start]
    new_lines = lines[:start + 1] + [''] + new_content.rstrip('\n').split('\n') + [''] + lines[end:]
    return '\n'.join(new_lines)


def append_after_section(text, target_title, new_content):
    """Insert new_content after a section ends (before the next heading)."""
    lines, sections = parse_sections(text)
    start, end, level = find_section_bounds(lines, sections, target_title)
    
    if start is None:
        print(f"ERROR: Section '{target_title}' not found.", file=sys.stderr)
        sys.exit(1)
    
    new_lines = lines[:end] + [''] + new_content.rstrip('\n').split('\n') + [''] + lines[end:]
    return '\n'.join(new_lines)


def read_content(args):
    if args.content:
        with open(args.content, 'r') as f:
            return f.read()
    elif args.content_stdin:
        return sys.stdin.read()
    elif args.content_inline:
        return args.content_inline
    return None


def main():
    parser = argparse.ArgumentParser(description='Safe _base.md section updater for gro agents.')
    parser.add_argument('--file', required=True, help='Path to the markdown file')
    parser.add_argument('--section', help='Section title to replace/update')
    parser.add_argument('--append-after', help='Section title to append content after')
    parser.add_argument('--content', help='Path to file containing new content')
    parser.add_argument('--content-stdin', action='store_true', help='Read content from stdin')
    parser.add_argument('--content-inline', help='Content as inline string argument')
    parser.add_argument('--list-sections', action='store_true', help='List all sections and exit')
    parser.add_argument('--dry-run', action='store_true', help='Print result without writing')
    
    args = parser.parse_args()
    
    if not os.path.exists(args.file):
        print(f"ERROR: File not found: {args.file}", file=sys.stderr)
        sys.exit(1)
    
    with open(args.file, 'r') as f:
        text = f.read()
    
    if args.list_sections:
        list_sections(text)
        return
    
    content = read_content(args)
    
    if args.section:
        if content is None:
            print("ERROR: --section requires content (--content, --content-stdin, or --content-inline)", file=sys.stderr)
            sys.exit(1)
        result = replace_section(text, args.section, content)
    elif args.append_after:
        if content is None:
            print("ERROR: --append-after requires content (--content, --content-stdin, or --content-inline)", file=sys.stderr)
            sys.exit(1)
        result = append_after_section(text, args.append_after, content)
    else:
        parser.print_help()
        sys.exit(1)
    
    if args.dry_run:
        print(result)
    else:
        with open(args.file, 'w') as f:
            f.write(result)
        print(f"Updated: {args.file}")


if __name__ == '__main__':
    main()
