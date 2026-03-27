---
description: Install plugin-dev CLI to PATH
allowed-tools:
  - Bash(*:*)
  - Read(*:*)
---

# Install plugin-dev

Install the `plugin-dev` CLI to `~/.local/bin` so it's available globally.

## Execution

Run all steps below in order.

### Step 1: Detect platform and install

```bash
OS="$(uname -s)"
TARGET="${HOME}/.local/bin/plugin-dev"
SOURCE="${CLAUDE_PLUGIN_ROOT}/scripts/plugin-dev"

mkdir -p "${HOME}/.local/bin"

case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    cp -f "$SOURCE" "$TARGET"
    chmod +x "$TARGET"
    echo "Copied: plugin-dev -> $TARGET"
    ;;
  *)
    ln -sf "$SOURCE" "$TARGET"
    echo "Symlinked: $TARGET -> $SOURCE"
    ;;
esac
```

### Step 2: Verify PATH

```bash
if ! echo "$PATH" | tr ':' '\n' | grep -qx "${HOME}/.local/bin"; then
  echo ""
  echo "WARNING: ~/.local/bin is not in your PATH"
  echo "Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
```

### Step 3: Confirm

```bash
plugin-dev version
```
