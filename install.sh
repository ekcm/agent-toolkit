#!/usr/bin/env bash
# Link every skill in skills/ into the user-level skill folders that coding
# agents read, so this repo is the single copy they all share.
#
#   ~/.agents/skills/<name>  -> Codex, pi, and other Agent Skills tools
#   ~/.claude/skills/<name>  -> Claude Code (does not read ~/.agents/skills)
#
# Anything already at a target path is moved to a timestamped backup folder,
# never deleted. Old copies in ~/.codex/skills are backed up and removed too,
# because Codex also reads ~/.agents/skills and would list each skill twice.
#
# Usage: ./install.sh [--dry-run] [--uninstall]

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$REPO_DIR/skills"

AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
CLAUDE_SKILLS="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_SKILLS="${CODEX_HOME:-$HOME/.codex}/skills"
BACKUP_DIR="${AGENT_TOOLKIT_BACKUP_DIR:-$HOME/.agent-toolkit-backups}/$(date +%Y%m%d-%H%M%S)"

# Folder names this repo used to install under before a rename.
LEGACY_NAMES=(
  "code-review(uncommitted-changes)"
  "verify-review(uncommitted-changes)"
)

DRY_RUN=0
UNINSTALL=0

usage() {
  cat <<EOF
Usage: ./install.sh [--dry-run] [--uninstall]

Symlinks each skill in skills/ into:
  $AGENTS_SKILLS
  $CLAUDE_SKILLS
and backs up our old copies from $CODEX_SKILLS.

Options:
  -n, --dry-run    Show what would change without changing anything
  -u, --uninstall  Remove the symlinks that point into this repo
  -h, --help       Show this help

Environment overrides: AGENTS_SKILLS_DIR, CLAUDE_SKILLS_DIR, CODEX_HOME,
AGENT_TOOLKIT_BACKUP_DIR.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -u|--uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

# Run the command unless this is a dry run. Callers print what it does.
run() {
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

# Move whatever is at $1 into the backup folder, under a subfolder named $2.
backup() {
  local path="$1" label="$2"
  local dest="$BACKUP_DIR/$label/$(basename "$path")"
  echo "  back up  $path -> $dest"
  run mkdir -p "$BACKUP_DIR/$label"
  run mv "$path" "$dest"
}

# True if $1 is a symlink whose target is inside this repo's skills/ folder.
links_into_repo() {
  [ -L "$1" ] && case "$(readlink "$1")" in "$SKILLS_DIR"/*) return 0 ;; *) return 1 ;; esac
}

skill_names() {
  local dir
  for dir in "$SKILLS_DIR"/*/; do
    if [ -f "$dir/SKILL.md" ]; then
      basename "$dir"
    fi
  done
}

link_skill() {
  local name="$1" target_dir="$2" label="$3"
  local src="$SKILLS_DIR/$name" dest="$target_dir/$name"

  if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$src" ]; then
    echo "  ok       $dest"
    return
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    backup "$dest" "$label"
  fi
  echo "  link     $dest -> $src"
  run ln -s "$src" "$dest"
}

install() {
  local names name target label
  names="$(skill_names)"
  if [ -z "$names" ]; then
    echo "No skills found in $SKILLS_DIR" >&2
    exit 1
  fi

  for target in "$AGENTS_SKILLS" "$CLAUDE_SKILLS"; do
    case "$target" in
      "$AGENTS_SKILLS") label="agents" ;;
      *) label="claude" ;;
    esac
    echo "$target"
    run mkdir -p "$target"
    for name in "${LEGACY_NAMES[@]}"; do
      if [ -e "$target/$name" ] || [ -L "$target/$name" ]; then
        backup "$target/$name" "$label"
      fi
    done
    for name in $names; do
      link_skill "$name" "$target" "$label"
    done
  done

  echo "$CODEX_SKILLS (old copies; Codex reads ~/.agents/skills)"
  if [ -d "$CODEX_SKILLS" ]; then
    for name in $names "${LEGACY_NAMES[@]}"; do
      if [ -e "$CODEX_SKILLS/$name" ] || [ -L "$CODEX_SKILLS/$name" ]; then
        backup "$CODEX_SKILLS/$name" "codex"
      fi
    done
  fi

  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "Dry run: nothing was changed."
  else
    echo "Done. Restart running agents so they pick up the skills."
    if [ -d "$BACKUP_DIR" ]; then
      echo "Backups: $BACKUP_DIR"
    fi
  fi
}

uninstall() {
  local target entry
  for target in "$AGENTS_SKILLS" "$CLAUDE_SKILLS"; do
    echo "$target"
    [ -d "$target" ] || continue
    for entry in "$target"/*; do
      if links_into_repo "$entry"; then
        echo "  remove   $entry"
        run rm "$entry"
      fi
    done
  done
  echo
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "Dry run: nothing was changed."
  else
    echo "Done. Earlier backups, if any, are in ${AGENT_TOOLKIT_BACKUP_DIR:-$HOME/.agent-toolkit-backups}."
  fi
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall
else
  install
fi
