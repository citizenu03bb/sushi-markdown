#!/usr/bin/env bash
set -euo pipefail

# Usage: tests/run.sh [--python-only]
#   --python-only     run only the HTML rendering checks (no GNOME Sushi needed)
# Environment:
#   SUSHI_ASSETS_DIR  where cached mermaid.min.js / mathjax-tex-svg.js live
#                     (default: ~/.local/share/sushi, as set up by install.sh)
#   GJS_TIMEOUT       seconds before a hung GJS test is killed (default: 120)

here=$(cd "$(dirname "$0")/.." && pwd)
python_only=false
[ "${1:-}" = "--python-only" ] && python_only=true
assets_dir=${SUSHI_ASSETS_DIR:-$HOME/.local/share/sushi}
gjs_timeout=${GJS_TIMEOUT:-120}
sushi_libdir="/usr/lib/$(uname -m)-linux-gnu/sushi"
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

echo "1. Testing render_markdown.py HTML & Mermaid generation..."
cat > "$tmpdir/sample.md" <<'EOF'
---
title: Sample Doc
author: Pat
---
# Heading One

> [!NOTE]
> Important callout box

- [x] Done item
- [ ] Todo item

See [Other](./other.md#details) and [Section](#heading-one).

```mermaid
graph TD
    A[Markdown File] --> B[render_markdown.py]
    B --> C[WebKit2 Preview]
```

```python
def greet():
    return 42
```

Inline math $e^{i\pi} + 1 = 0$, a price of $5 and $10, and `$not_math$`.

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

```math
a_1 * b_2 * c_3
```
EOF

html_out=$(python3 "$here/render_markdown.py" "$tmpdir/sample.md" dark)

grep -q 'class="theme-dark"' <<<"$html_out"
grep -q '<details class="frontmatter">' <<<"$html_out"
grep -q 'markdown-alert-note' <<<"$html_out"
grep -q 'task-list-item-checkbox" checked disabled' <<<"$html_out"
grep -q '<pre class="mermaid">' <<<"$html_out"
grep -q 'mermaid.initialize' <<<"$html_out"
grep -q 'window.__sushiScrollTo' <<<"$html_out"
grep -q 'sushi-md://back' <<<"$html_out"
echo "   OK: HTML output contains dark theme, frontmatter, alerts, task checkboxes, Mermaid block, and JS bridge."

grep -qF '<span class="math math-inline">\(e^{i\pi} + 1 = 0\)</span>' <<<"$html_out"
grep -qF '<div class="math math-display">\[\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}\]</div>' <<<"$html_out"
grep -qF '<div class="math math-display">\[a_1 * b_2 * c_3\]</div>' <<<"$html_out"
grep -qF 'a price of $5 and $10' <<<"$html_out"
grep -qF '<code>$not_math$</code>' <<<"$html_out"
grep -q 'window.MathJax' <<<"$html_out"
if python3 "$here/render_markdown.py" "$here/README.md" dark | grep -q 'window.MathJax'; then
    echo "MathJax must not be loaded for documents without math" >&2
    exit 1
fi
echo "   OK: LaTeX inline/display/fenced math extracted; prices and code spans left untouched."

if $python_only; then
    echo "Python tests passed (GJS tests skipped)."
    exit 0
fi

echo "2. Testing GJS Sushi MimeHandler & MarkdownRenderer..."
export XDG_DATA_HOME="$tmpdir/xdg_data"
mkdir -p "$XDG_DATA_HOME/sushi/viewers"
ln -s "$here/render_markdown.py" "$XDG_DATA_HOME/sushi/render_markdown.py"
ln -s "$here/viewers/markdown.js" "$XDG_DATA_HOME/sushi/viewers/markdown.js"
for asset in mermaid.min.js mathjax-tex-svg.js; do
    if [ -f "$assets_dir/$asset" ]; then
        ln -s "$assets_dir/$asset" "$XDG_DATA_HOME/sushi/$asset"
    fi
done

GI_TYPELIB_PATH="$sushi_libdir/girepository-1.0" \
LD_LIBRARY_PATH="$sushi_libdir" \
timeout "$gjs_timeout" gjs -c "
const {Gio, GLib} = imports.gi;
const res = Gio.Resource.load('/usr/share/sushi/org.gnome.NautilusPreviewer.src.gresource');
res._register();
imports.searchPath.unshift('resource:///org/gnome/NautilusPreviewer/js');
window.pkg = { pkgdatadir: '/usr/share/sushi', name: 'org.gnome.NautilusPreviewer' };
window._ = (s) => s;
imports.gi.versions.Gtk = '3.0';
imports.gi.versions.Gdk = '3.0';
imports.gi.versions.GtkSource = '4';
imports.gi.versions.EvinceDocument = '3.0';
imports.gi.versions.EvinceView = '3.0';
imports.gi.versions.Gst = '1.0';
imports.gi.versions.GstTag = '1.0';
imports.gi.versions.Soup = '3.0';
const {Gtk} = imports.gi;
Gtk.init(null);
const MimeHandler = imports.ui.mimeHandler;
let klass = MimeHandler.getKlass('text/markdown');
if (klass.name !== 'MarkdownRenderer') {
    throw new Error('Expected MarkdownRenderer, got ' + klass.name);
}
let f = Gio.File.new_for_path('$tmpdir/sample.md');
let info = f.query_info('*', Gio.FileQueryInfoFlags.NONE, null);
let r = new klass(f, info);
let tb = r.toolbar;
function fail(msg) {
    printerr('FAIL: ' + msg);
    imports.system.exit(1);
}
let attempts = 0;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
    if (!tb.get_visible() || !tb.box.get_visible()) {
        fail('Toolbar was not made visible');
    }
    // Mermaid and MathJax render asynchronously after load; poll for both
    let probe = '[!!document.querySelector(\".mermaid svg\"), document.querySelectorAll(\".math mjx-container svg\").length].join()';
    r._webView.run_javascript(probe, null, (obj, res) => {
        let [hasSvg, mathCount] = obj.run_javascript_finish(res).get_js_value().to_string().split(',');
        if (hasSvg === 'true' && mathCount === '3') {
            print('   OK: Resolved MarkdownRenderer, verified toolbar visibility, rendered Mermaid SVG and 3 MathJax formulas.');
            imports.system.exit(0);
        }
        if (++attempts >= 50) {
            fail('Mermaid SVG rendered: ' + hasSvg + ', MathJax formulas: ' + mathCount + ' (expected 3)');
        }
    });
    return GLib.SOURCE_CONTINUE;
});
Gtk.main();
"

echo "3. Testing navigation between linked Markdown files..."
nav="$tmpdir/nav"
mkdir -p "$nav/sub"
filler=$(for i in $(seq 1 80); do printf 'Filler paragraph %s.\n\n' "$i"; done)
cat > "$nav/a.md" <<EOF
# Page A

- [B](b.md)
- [Sub](sub/)
- [Guide](guide)
- [Draft](notes%20(draft).md)

$filler

## Deep Section

Bottom of A.
EOF
cat > "$nav/b.md" <<'EOF'
# Page B

[Back to A, deep](./a.md#deep-section)
EOF
cat > "$nav/guide.md" <<'EOF'
# Guide

Inline $a^2 + b^2 = c^2$ and display:

$$
\sum_{n=1}^{\infty} \frac{1}{n^2} = \frac{\pi^2}{6}
$$
EOF
cat > "$nav/notes (draft).md" <<EOF
# Draft Notes

[Jump to end](notes%20(draft).md#the-end)

$filler

## The End
EOF
cat > "$nav/sub/README.md" <<'EOF'
# Sub Readme

- [C](c.md)
- [Up](../a.md)
EOF
cat > "$nav/sub/c.md" <<'EOF'
# Page C

- [This directory](./)
- [Up](../a.md)
EOF

GI_TYPELIB_PATH="$sushi_libdir/girepository-1.0" \
LD_LIBRARY_PATH="$sushi_libdir" \
timeout "$gjs_timeout" gjs "$here/tests/navigation.js" "$nav"

echo "All tests passed."
