#!/usr/bin/env python3
"""Convert a Markdown file to a standalone, styled HTML document for GNOME Sushi."""

import html
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

import markdown
from pygments.formatters import HtmlFormatter

# Maximum file size to read (10 MiB) — prevents DoS via huge files
MAX_FILE_SIZE = 10 * 1024 * 1024

# Whitelist of HTML tags allowed in rendered Markdown output.
# Anything not in this list is stripped to prevent XSS.
ALLOWED_TAGS = frozenset({
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
    'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt',
    'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre',
    'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
    'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
    'tr', 'u', 'ul', 'var', 'input',
})

# Attributes allowed per tag (global attributes allowed on all tags)
ALLOWED_ATTRS = {
    '*': {'class', 'id', 'title', 'lang', 'dir'},
    'a': {'href', 'name', 'target', 'rel'},
    'img': {'src', 'alt', 'width', 'height', 'loading'},
    'input': {'type', 'checked', 'disabled'},
    'th': {'align', 'colspan', 'rowspan'},
    'td': {'align', 'colspan', 'rowspan'},
    'col': {'span'},
    'colgroup': {'span'},
    'ol': {'start', 'type'},
    'li': {'value'},
    'details': {'open'},
    'code': {'class'},  # for language-xxx classes from Pygments
    'pre': {'class'},
    'div': {'class'},
    'span': {'class'},
}

# URL schemes allowed in href/src
ALLOWED_SCHEMES = frozenset({'http', 'https', 'mailto', 'file', 'data'})


class _Sanitizer(HTMLParser):
    """Strip disallowed HTML tags and attributes to prevent XSS."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._out = []
        self._skip_depth = 0
        self._skip_tag = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if self._skip_depth > 0:
            if tag == self._skip_tag:
                self._skip_depth += 1
            return
        if tag not in ALLOWED_TAGS:
            # Skip this tag and its content for container tags
            if tag in ('script', 'style', 'iframe', 'object', 'embed',
                       'form', 'button', 'select', 'textarea', 'svg',
                       'math', 'link', 'meta', 'base'):
                self._skip_depth = 1
                self._skip_tag = tag
            return
        # Filter attributes
        allowed = ALLOWED_ATTRS.get(tag, set()) | ALLOWED_ATTRS.get('*', set())
        clean_attrs = []
        for name, value in attrs:
            name = name.lower()
            if name not in allowed:
                continue
            if name in ('href', 'src') and value:
                # Validate URL scheme
                scheme = value.split(':', 1)[0].lower() if ':' in value else ''
                if scheme and scheme not in ALLOWED_SCHEMES:
                    continue
                # Block javascript: and other dangerous schemes explicitly
                if value.strip().lower().startswith(('javascript:', 'vbscript:', 'data:text/html')):
                    continue
            clean_attrs.append((name, value))
        attr_str = ''.join(
            f' {n}' if v is None else f' {n}="{html.escape(v, quote=True)}"'
            for n, v in clean_attrs
        )
        self._out.append(f'<{tag}{attr_str}>')

    def handle_startendtag(self, tag, attrs):
        tag = tag.lower()
        if tag in ALLOWED_TAGS and self._skip_depth == 0:
            allowed = ALLOWED_ATTRS.get(tag, set()) | ALLOWED_ATTRS.get('*', set())
            clean_attrs = []
            for name, value in attrs:
                name = name.lower()
                if name not in allowed:
                    continue
                if name in ('href', 'src') and value:
                    scheme = value.split(':', 1)[0].lower() if ':' in value else ''
                    if scheme and scheme not in ALLOWED_SCHEMES:
                        continue
                    if value.strip().lower().startswith(('javascript:', 'vbscript:', 'data:text/html')):
                        continue
                clean_attrs.append((name, value))
            attr_str = ''.join(
                f' {n}' if v is None else f' {n}="{html.escape(v, quote=True)}"'
                for n, v in clean_attrs
            )
            self._out.append(f'<{tag}{attr_str}/>')

    def handle_endtag(self, tag):
        tag = tag.lower()
        if self._skip_depth > 0:
            if tag == self._skip_tag:
                self._skip_depth -= 1
                if self._skip_depth == 0:
                    self._skip_tag = None
            return
        if tag in ALLOWED_TAGS:
            self._out.append(f'</{tag}>')

    def handle_data(self, data):
        if self._skip_depth == 0:
            self._out.append(html.escape(data))

    def get_output(self) -> str:
        return ''.join(self._out)


def sanitize_html(raw_html: str) -> str:
    """Remove dangerous HTML tags, attributes, and URL schemes."""
    parser = _Sanitizer()
    parser.feed(raw_html)
    parser.close()
    return parser.get_output()


TASK_ITEM_RE = re.compile(
    r'<li>\s*\[([ xX])\]\s*',
    re.IGNORECASE,
)

GITHUB_ALERT_RE = re.compile(
    r'<blockquote>\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*/?>|\n)?',
    re.IGNORECASE,
)

MERMAID_FENCE_RE = re.compile(
    r'^(?P<indent>[ \t]*)(?P<fence>`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n'
    r'(?P<code>.*?)'
    r'^(?P=indent)(?P=fence)[ \t]*$',
    re.MULTILINE | re.DOTALL | re.IGNORECASE,
)

MERMAID_CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'


def _replace_task_item(match: re.Match) -> str:
    checked = match.group(1).lower() == 'x'
    attr = ' checked disabled' if checked else ' disabled'
    return f'<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox"{attr}> '


def _replace_alert(match: re.Match) -> str:
    kind = match.group(1).upper()
    labels = {
        'NOTE': 'Note',
        'TIP': 'Tip',
        'IMPORTANT': 'Important',
        'WARNING': 'Warning',
        'CAUTION': 'Caution',
    }
    label = labels.get(kind, kind.title())
    return (
        f'<blockquote class="markdown-alert markdown-alert-{kind.lower()}">'
        f'<p class="markdown-alert-title">{label}</p><p>'
    )


def strip_frontmatter(text: str) -> tuple[str, str]:
    """Extract optional YAML frontmatter and render it as a subtle metadata table."""
    if not text.startswith('---\n') and not text.startswith('---\r\n'):
        return '', text
    end = text.find('\n---', 3)
    if end == -1:
        return '', text
    after = text.find('\n', end + 4)
    if after == -1:
        return '', text
    fm_raw = text[4:end].strip()
    body = text[after + 1:]
    if not fm_raw:
        return '', body
    rows = []
    for line in fm_raw.splitlines():
        if ':' in line and not line.startswith((' ', '\t', '-')):
            k, v = line.split(':', 1)
            rows.append(
                f'<tr><th>{html.escape(k.strip())}</th>'
                f'<td>{html.escape(v.strip())}</td></tr>'
            )
    if not rows:
        return '', body
    fm_html = (
        '<details class="frontmatter"><summary>Frontmatter</summary>'
        f'<table><tbody>{"".join(rows)}</tbody></table></details>'
    )
    return fm_html, body


def extract_mermaid_blocks(text: str) -> tuple[str, list[str]]:
    """Replace fenced ```mermaid blocks with placeholders before Markdown/Pygments processing."""
    blocks: list[str] = []

    def _sub(match: re.Match) -> str:
        idx = len(blocks)
        blocks.append(match.group('code').strip())
        return f'\n\n<!--SUSHI_MERMAID_{idx}-->\n\n'

    processed = MERMAID_FENCE_RE.sub(_sub, text)
    return processed, blocks


def restore_mermaid_blocks(rendered_html: str, blocks: list[str]) -> str:
    """Restore extracted Mermaid blocks as <pre class="mermaid"> containers."""
    for idx, code in enumerate(blocks):
        placeholder = f'<!--SUSHI_MERMAID_{idx}-->'
        replacement = (
            '<div class="mermaid-container">'
            f'<pre class="mermaid">{html.escape(code)}</pre>'
            '</div>'
        )
        rendered_html = rendered_html.replace(f'<p>{placeholder}</p>', replacement)
        rendered_html = rendered_html.replace(placeholder, replacement)
    return rendered_html


def _get_mermaid_script_src() -> str:
    """Locate a local mermaid.min.js for offline rendering, falling back to jsDelivr CDN."""
    xdg_data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    candidates = [
        Path(xdg_data) / 'sushi' / 'mermaid.min.js',
        Path(__file__).resolve().parent / 'vendor' / 'mermaid.min.js',
        Path('/usr/share/javascript/mermaid/mermaid.min.js'),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.as_uri()
    return MERMAID_CDN_URL


def render_markdown(filepath: str, dark_mode: bool = True) -> str:
    path = Path(filepath)

    # Guard: refuse to read files larger than MAX_FILE_SIZE
    file_size = path.stat().st_size
    if file_size > MAX_FILE_SIZE:
        raise ValueError(
            f'File too large ({file_size / 1024 / 1024:.1f} MiB). '
            f'Maximum allowed is {MAX_FILE_SIZE / 1024 / 1024:.0f} MiB.'
        )

    raw = path.read_text(encoding='utf-8', errors='replace')
    fm_html, body = strip_frontmatter(raw)
    body, mermaid_blocks = extract_mermaid_blocks(body)

    md = markdown.Markdown(
        extensions=[
            'extra',
            'codehilite',
            'toc',
            'sane_lists',
        ],
        extension_configs={
            'codehilite': {
                'css_class': 'highlight',
                'guess_lang': False,
                'use_pygments': True,
            },
        },
    )
    rendered = md.convert(body)
    rendered = TASK_ITEM_RE.sub(_replace_task_item, rendered)
    rendered = GITHUB_ALERT_RE.sub(_replace_alert, rendered)
    if mermaid_blocks:
        rendered = restore_mermaid_blocks(rendered, mermaid_blocks)

    # Sanitize: strip dangerous HTML tags, attributes, and URL schemes
    rendered = sanitize_html(rendered)

    pygments_style = 'monokai' if dark_mode else 'friendly'
    pygments_css = HtmlFormatter(style=pygments_style).get_style_defs('.highlight')

    theme_class = 'theme-dark' if dark_mode else 'theme-light'

    mermaid_script = ''
    mermaid_csp_src = ''
    if mermaid_blocks:
        mermaid_src = _get_mermaid_script_src()
        mermaid_theme = 'dark' if dark_mode else 'default'
        # If Mermaid is loaded from a CDN, allow that origin in CSP
        if mermaid_src.startswith('http'):
            from urllib.parse import urlparse
            parsed = urlparse(mermaid_src)
            mermaid_csp_src = f' {parsed.scheme}://{parsed.netloc}'
        mermaid_script = f"""
<script src="{mermaid_src}"></script>
<script>
if (window.mermaid) {{
    mermaid.initialize({{
        startOnLoad: true,
        theme: '{mermaid_theme}',
        securityLevel: 'strict',
        fontFamily: '"Cantarell", "Inter", system-ui, sans-serif'
    }});
}}
</script>"""

    return f"""<!DOCTYPE html>
<html class="{theme_class}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'{mermaid_csp_src}; style-src 'self' 'unsafe-inline'; img-src 'self' file: data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none';">
<style>
:root.theme-dark {{
    --bg: #1e1e1e;
    --fg: #e6edf3;
    --muted: #8b949e;
    --border: #30363d;
    --code-bg: #161b22;
    --inline-code-bg: rgba(110, 118, 129, 0.35);
    --table-alt: #252526;
    --link: #58a6ff;
    --quote-border: #3b434b;
    --alert-note: #2f81f7;
    --alert-tip: #3fb950;
    --alert-important: #a371f7;
    --alert-warning: #d29922;
    --alert-caution: #f85149;
}}
:root.theme-light {{
    --bg: #ffffff;
    --fg: #1f2328;
    --muted: #656d76;
    --border: #d0d7de;
    --code-bg: #f6f8fa;
    --inline-code-bg: rgba(175, 184, 193, 0.25);
    --table-alt: #f6f8fa;
    --link: #0969da;
    --quote-border: #d0d7de;
    --alert-note: #0969da;
    --alert-tip: #1a7f37;
    --alert-important: #8250df;
    --alert-warning: #9a6700;
    --alert-caution: #d1242f;
}}
* {{
    box-sizing: border-box;
}}
html, body {{
    margin: 0;
    padding: 0;
    background-color: var(--bg);
    color: var(--fg);
    font-family: "Cantarell", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
}}
.markdown-body {{
    max-width: 880px;
    margin: 0 auto;
    padding: 28px 36px 56px 36px;
    word-wrap: break-word;
}}
h1, h2, h3, h4, h5, h6 {{
    margin-top: 24px;
    margin-bottom: 14px;
    font-weight: 600;
    line-height: 1.25;
}}
h1 {{
    font-size: 1.9em;
    padding-bottom: 0.3em;
    border-bottom: 1px solid var(--border);
}}
h2 {{
    font-size: 1.45em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--border);
}}
h3 {{ font-size: 1.2em; }}
h4 {{ font-size: 1.05em; }}
h5, h6 {{ font-size: 0.95em; color: var(--muted); }}
p, blockquote, ul, ol, dl, table, pre, details {{
    margin-top: 0;
    margin-bottom: 16px;
}}
a {{
    color: var(--link);
    text-decoration: none;
    cursor: pointer;
}}
a:hover {{
    text-decoration: underline;
}}
hr {{
    height: 2px;
    padding: 0;
    margin: 24px 0;
    background-color: var(--border);
    border: 0;
}}
blockquote {{
    padding: 0 1em;
    color: var(--muted);
    border-left: 0.25em solid var(--quote-border);
}}
blockquote > :first-child {{ margin-top: 0; }}
blockquote > :last-child {{ margin-bottom: 0; }}
.markdown-alert {{
    padding: 10px 16px;
    color: var(--fg);
    border-left-width: 4px;
    border-radius: 4px;
    background-color: var(--code-bg);
}}
.markdown-alert-title {{
    font-weight: 600;
    margin-bottom: 4px;
}}
.markdown-alert-note {{ border-left-color: var(--alert-note); }}
.markdown-alert-note .markdown-alert-title {{ color: var(--alert-note); }}
.markdown-alert-tip {{ border-left-color: var(--alert-tip); }}
.markdown-alert-tip .markdown-alert-title {{ color: var(--alert-tip); }}
.markdown-alert-important {{ border-left-color: var(--alert-important); }}
.markdown-alert-important .markdown-alert-title {{ color: var(--alert-important); }}
.markdown-alert-warning {{ border-left-color: var(--alert-warning); }}
.markdown-alert-warning .markdown-alert-title {{ color: var(--alert-warning); }}
.markdown-alert-caution {{ border-left-color: var(--alert-caution); }}
.markdown-alert-caution .markdown-alert-title {{ color: var(--alert-caution); }}
ul, ol {{
    padding-left: 2em;
}}
li + li {{
    margin-top: 0.25em;
}}
li.task-list-item {{
    list-style-type: none;
    margin-left: -1.4em;
}}
.task-list-item-checkbox {{
    margin: 0 0.4em 0.15em 0;
    vertical-align: middle;
}}
code, tt {{
    padding: 0.2em 0.4em;
    margin: 0;
    font-size: 88%;
    background-color: var(--inline-code-bg);
    border-radius: 5px;
    font-family: "JetBrains Mono", "Ubuntu Mono", "Fira Code", "DejaVu Sans Mono", monospace;
}}
pre {{
    padding: 14px 16px;
    overflow: auto;
    font-size: 88%;
    line-height: 1.45;
    background-color: var(--code-bg) !important;
    border: 1px solid var(--border);
    border-radius: 8px;
}}
pre code {{
    padding: 0;
    margin: 0;
    font-size: 100%;
    background: transparent;
    border: 0;
}}
.highlight {{
    background-color: var(--code-bg) !important;
    border-radius: 8px;
    margin-bottom: 16px;
}}
.mermaid-container {{
    margin-bottom: 16px;
    padding: 16px;
    background-color: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow-x: auto;
    text-align: center;
}}
pre.mermaid {{
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent !important;
    font-family: inherit;
    text-align: center;
}}
table {{
    border-spacing: 0;
    border-collapse: collapse;
    width: max-content;
    max-width: 100%;
    overflow: auto;
    display: block;
}}
table th, table td {{
    padding: 7px 13px;
    border: 1px solid var(--border);
}}
table th {{
    font-weight: 600;
    background-color: var(--code-bg);
}}
table tr:nth-child(2n) {{
    background-color: var(--table-alt);
}}
img {{
    max-width: 100%;
    height: auto;
    border-radius: 4px;
}}
details.frontmatter {{
    font-size: 0.85em;
    color: var(--muted);
    background-color: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    margin-bottom: 20px;
}}
details.frontmatter summary {{
    cursor: pointer;
    font-weight: 600;
}}
details.frontmatter table {{
    margin-top: 8px;
    margin-bottom: 4px;
}}
{pygments_css}
</style>
</head>
<body>
<article class="markdown-body">
{fm_html}
{rendered}
</article>{mermaid_script}
<script>
window.__sushiScrollTo = function(id) {{
    if (!id) {{
        window.scrollTo({{ top: 0, behavior: 'instant' }});
        return;
    }}
    let el = document.getElementById(id) || document.getElementsByName(id)[0];
    if (!el) {{
        let lower = id.toLowerCase();
        el = document.getElementById(lower);
    }}
    if (el) {{
        el.scrollIntoView({{ behavior: 'smooth', block: 'start' }});
    }}
}};
document.addEventListener('click', function(e) {{
    let a = e.target.closest('a');
    if (!a) return;
    let href = a.getAttribute('href');
    if (href && href.startsWith('#')) {{
        e.preventDefault();
        window.__sushiScrollTo(decodeURIComponent(href.slice(1)));
    }}
}});
window.addEventListener('keydown', function(e) {{
    if (e.altKey && e.key === 'ArrowLeft') {{
        e.preventDefault();
        window.location.href = 'sushi-md://back';
    }} else if (e.altKey && e.key === 'ArrowRight') {{
        e.preventDefault();
        window.location.href = 'sushi-md://forward';
    }} else if (e.key === 'Backspace' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {{
        e.preventDefault();
        window.location.href = 'sushi-md://back';
    }} else if ((e.ctrlKey || e.metaKey) && (e.key === 'u' || e.key === 'U')) {{
        e.preventDefault();
        window.location.href = 'sushi-md://toggle-raw';
    }}
}});
</script>
</body>
</html>
"""


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: render_markdown.py <filepath> [dark|light]', file=sys.stderr)
        sys.exit(1)
    filepath = sys.argv[1]
    dark = True
    if len(sys.argv) >= 3:
        dark = sys.argv[2].lower() != 'light'
    try:
        sys.stdout.write(render_markdown(filepath, dark_mode=dark))
    except FileNotFoundError:
        print(f'Error: file not found: {filepath}', file=sys.stderr)
        sys.exit(2)
    except ValueError as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f'Unexpected error: {e}', file=sys.stderr)
        sys.exit(4)
