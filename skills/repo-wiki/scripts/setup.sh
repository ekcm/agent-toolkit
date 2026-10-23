#!/bin/sh
# Create (once) the Python environment repo-wiki's scripts run in, and print its interpreter path.
# Usage: sh setup.sh            -> prints the python path on the last line
set -eu

HOME_DIR="${REPO_WIKI_HOME:-$HOME/.agent-toolkit/repo-wiki}"
VENV="$HOME_DIR/.venv"
PY="$VENV/bin/python"

mkdir -p "$HOME_DIR"
if [ ! -x "$PY" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv --quiet "$VENV" >&2
  else
    python3 -m venv "$VENV" >&2
  fi
fi

if ! "$PY" -I -c "import tree_sitter_language_pack" >/dev/null 2>&1; then
  echo "Installing tree-sitter into $VENV ..." >&2
  if command -v uv >/dev/null 2>&1; then
    uv pip install --quiet --python "$PY" "tree-sitter==0.23.2" "tree-sitter-language-pack==0.6.1" >&2
  else
    "$PY" -m pip install --quiet --disable-pip-version-check "tree-sitter==0.23.2" "tree-sitter-language-pack==0.6.1" >&2
  fi
fi

"$PY" -I -c "from tree_sitter_language_pack import get_parser; get_parser('python')" >/dev/null
echo "$PY"
