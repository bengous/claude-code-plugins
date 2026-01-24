#!/usr/bin/env bash
# Track Claude Code system prompt changes across versions
set -euo pipefail

# === Dependencies ===
command -v git &>/dev/null || { echo "Error: git required" >&2; exit 1; }

# === Repository Discovery ===
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "Error: Not in a git repository" >&2
    exit 1
}

# === Config (internal, not user-configurable) ===
DUMP_FILE="claude-meta-tools/references/system-prompt-dump.md"
DUMP_PATH="${REPO_ROOT}/${DUMP_FILE}"

detect_claude_version() {
    if command -v claude &>/dev/null; then
        claude --version 2>/dev/null | head -1 || echo "unknown"
    else
        echo "claude-not-found"
    fi
}

# Returns 0 if changes exist, 1 if no changes
check_for_changes() {
    if [[ -f "${DUMP_PATH}" ]]; then
        if git diff --quiet "${DUMP_PATH}" 2>/dev/null; then
            echo "No changes detected" >&2
            return 1
        else
            echo "Changes detected in system prompt dump" >&2
            return 0
        fi
    else
        echo "No previous dump found" >&2
        return 0
    fi
}

main() {
    local version
    version=$(detect_claude_version)

    echo "Claude Code version: ${version}"
    echo "Dump file: ${DUMP_PATH}"
    echo ""

    case "${1:-}" in
        --check)
            check_for_changes
            ;;
        --commit)
            # shellcheck disable=SC2310
            if check_for_changes; then
                git add "${DUMP_PATH}" && git commit -m "chore: update system prompt dump for Claude ${version}"
                echo "Committed changes"
            fi
            ;;
        --diff)
            if [[ -f "${DUMP_PATH}" ]]; then
                git diff "${DUMP_PATH}"
            else
                echo "Error: No dump file to diff" >&2
                exit 1
            fi
            ;;
        *)
            echo "Usage: $0 [--check|--commit|--diff]"
            echo ""
            echo "Run /dump-system-prompt in Claude first, then:"
            echo "  --check   Check if dump changed"
            echo "  --commit  Commit changes with version tag"
            echo "  --diff    Show diff of changes"
            ;;
    esac
}

main "$@"
