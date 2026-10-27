#!/usr/bin/env bash
# Symlink sushi-markdown into ~/.local/share/sushi and restart GNOME Sushi.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
target_dir="${XDG_DATA_HOME:-$HOME/.local/share}/sushi"

# --- Vérification des dépendances ---
echo "Checking dependencies..."

check_dep() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: '$1' is not installed." >&2
        echo "  Install it with: sudo apt install $2" >&2
        exit 1
    fi
}

check_dep python3 python3
check_dep sushi gnome-sushi

# Vérifier les modules Python
for mod in markdown pygments; do
    if ! python3 -c "import $mod" 2>/dev/null; then
        echo "ERROR: Python module '$mod' is not installed." >&2
        echo "  Install it with: sudo apt install python3-$mod" >&2
        exit 1
    fi
done
echo "  All dependencies OK."

chmod +x "$here/render_markdown.py"
mkdir -p "$target_dir/viewers"

ln -sfn "$here/render_markdown.py" "$target_dir/render_markdown.py"
ln -sfn "$here/viewers/markdown.js" "$target_dir/viewers/markdown.js"

echo "viewer -> $target_dir/viewers/markdown.js"
echo "helper -> $target_dir/render_markdown.py"

# --- Cache mermaid.min.js locally for offline diagram rendering ---
cache_mermaid() {
    if [ -f "$target_dir/mermaid.min.js" ]; then
        return 0
    fi

    # Try system-installed mermaid first
    for local_mermaid in \
        "/usr/share/javascript/mermaid/mermaid.min.js" \
        "/usr/share/javascript/mermaid/mermaid.js"; do
        if [ -f "$local_mermaid" ]; then
            cp "$local_mermaid" "$target_dir/mermaid.min.js"
            echo "mermaid -> $target_dir/mermaid.min.js (copied from system)"
            return 0
        fi
    done

    # Download from CDN (not checksum-verified: mermaid@11 is a moving tag)
    if command -v curl >/dev/null 2>&1; then
        local tmp_mermaid
        tmp_mermaid=$(mktemp)
        if curl -fsSL "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js" -o "$tmp_mermaid"; then
            mv "$tmp_mermaid" "$target_dir/mermaid.min.js"
            echo "mermaid -> $target_dir/mermaid.min.js (downloaded from jsDelivr)"
            return 0
        fi
        rm -f "$tmp_mermaid"
    fi

    echo "WARNING: Could not obtain mermaid.min.js — Mermaid diagrams will not render." >&2
    echo "  Install it manually: sudo apt install libjs-mermaid" >&2
    return 1
}

cache_mermaid || true

if pkill -f org.gnome.NautilusPreviewer 2>/dev/null; then
    echo "restarted org.gnome.NautilusPreviewer"
fi

echo ""
echo "Installation complete. Press Space on a .md file in Nautilus to preview."
