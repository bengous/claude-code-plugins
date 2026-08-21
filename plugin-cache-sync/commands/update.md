---
description: Update plugin-cache-sync CLI installation
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Update plugin-cache-sync

Verify and fix the `plugin-cache-sync` CLI installation.

## Execution

```bash
OS="$(uname -s)"
TARGET="${HOME}/.local/bin/plugin-cache-sync"
SOURCE="${CLAUDE_PLUGIN_ROOT}/scripts/plugin-cache-sync"

if [[ ! -f "$TARGET" && ! -L "$TARGET" ]]; then
  echo "Not installed. Run /plugin-cache-sync:install first."
  exit 1
fi

case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    cp -f "$SOURCE" "$TARGET"
    chmod +x "$TARGET"
    echo "Updated: copied latest plugin-cache-sync to $TARGET"
    ;;
  *)
    if [[ -L "$TARGET" ]]; then
      current=$(readlink "$TARGET")
      if [[ "$current" == "$SOURCE" ]]; then
        echo "OK: symlink is valid"
      else
        ln -sf "$SOURCE" "$TARGET"
        echo "Fixed: updated symlink to $SOURCE"
      fi
    else
      echo "WARNING: $TARGET is a regular file, not a symlink. Re-creating as symlink."
      ln -sf "$SOURCE" "$TARGET"
      echo "Fixed: replaced with symlink to $SOURCE"
    fi
    ;;
esac

plugin-cache-sync version
```
