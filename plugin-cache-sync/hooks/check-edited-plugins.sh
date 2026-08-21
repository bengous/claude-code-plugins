#!/usr/bin/env bash
# Validates plugins edited in the working tree. Both checks read the source
# directory on disk, so they see an edit the moment it lands — no cache, no sync.
#
#   edit mode (PostToolUse)  the plugin holding the written file, manifest only
#   stop mode (Stop)         every plugin with uncommitted changes, plus a cold load
#
# Blocks with exit 2 so the failure reaches Claude instead of the user.
set -euo pipefail

mode="${1:-stop}"

# The cold load spawns `claude`, whose own hooks would spawn again.
if [[ -n "${PLUGIN_CHECK_RUNNING:-}" ]]; then
	exit 0
fi

command -v claude >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)

# Nearest ancestor of $1 that declares a marketplace.
marketplace_root() {
	local dir="$1"
	while [[ "$dir" != "/" && ! -f "$dir/.claude-plugin/marketplace.json" ]]; do
		dir=$(dirname "$dir")
	done
	[[ -f "$dir/.claude-plugin/marketplace.json" ]] && printf '%s\n' "$dir"
}

# Mid-edit, a plugin is legitimately incomplete, so --strict is wrong here: it
# fails a manifest that merely lacks a description. Plain validate still catches
# malformed JSON and malformed frontmatter, which are broken at any stage.
validate_plugin() {
	local path="$1" label="$2"
	local out
	if ! out=$(claude plugin validate "$path" 2>&1); then
		printf 'Plugin %s failed validation. Fix it before continuing.\n\n%s\n' "$label" "$out" >&2
		exit 2
	fi
}

if [[ "$mode" == "edit" ]]; then
	file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
	[[ -n "$file" ]] || exit 0

	# Walk up from the file to the plugin that owns it.
	dir=$(dirname "$file")
	while [[ "$dir" != "/" && ! -f "$dir/.claude-plugin/plugin.json" ]]; do
		dir=$(dirname "$dir")
	done
	[[ -f "$dir/.claude-plugin/plugin.json" ]] || exit 0

	validate_plugin "$dir" "$(basename "$dir")"
	exit 0
fi

cwd=$(jq -r '.cwd // empty' <<<"$input")
[[ -n "$cwd" && -d "$cwd" ]] || exit 0
repo=$(marketplace_root "$cwd") || exit 0
[[ -n "$repo" ]] || exit 0

# Results are keyed by content, so an unchanged plugin is never re-checked.
cache_dir="${TMPDIR:-/tmp}/plugin-check-$(id -u)/$(printf '%s' "$repo" | sha256sum | cut -c1-16)"
mkdir -p "$cache_dir"

plugin_hash() {
	find "$1" -type f -exec sha256sum {} + | sort | sha256sum | cut -d' ' -f1
}

edited_plugins() {
	git -C "$repo" status --porcelain --untracked-files=all 2>/dev/null |
		sed 's/^...//; s/.* -> //' |
		cut -d/ -f1 |
		sort -u |
		while read -r dir; do
			[[ -f "$repo/$dir/.claude-plugin/plugin.json" ]] && printf '%s\n' "$dir"
		done
}

failures=()

while read -r dir; do
	[[ -n "$dir" ]] || continue
	path="$repo/$dir"
	hash=$(plugin_hash "$path")
	marker="$cache_dir/$dir.$hash"
	[[ -f "$marker" ]] && continue

	name=$(jq -r '.name // empty' "$path/.claude-plugin/plugin.json" 2>/dev/null || true)
	if [[ -z "$name" ]]; then
		failures+=("$dir: .claude-plugin/plugin.json has no readable \"name\"")
		continue
	fi

	if ! out=$(claude plugin validate "$path" --strict 2>&1); then
		failures+=("$dir: claude plugin validate --strict failed"$'\n'"$out")
		continue
	fi

	if ! out=$(PLUGIN_CHECK_RUNNING=1 claude --plugin-dir "$path" plugin details "$name" 2>&1); then
		failures+=("$dir: does not load from source"$'\n'"$out")
		continue
	fi

	touch "$marker"
done < <(edited_plugins)

if ((${#failures[@]} > 0)); then
	{
		printf 'Edited plugins failed their checks. Fix these before ending the turn.\n\n'
		printf '%s\n\n' "${failures[@]}"
	} >&2
	exit 2
fi

exit 0
