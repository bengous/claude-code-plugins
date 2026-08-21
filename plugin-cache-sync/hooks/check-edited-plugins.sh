#!/usr/bin/env bash
# Stop hook: validate and cold-load every plugin edited in the working tree.
# Blocks (exit 2) when a plugin no longer validates or no longer loads from source.
set -euo pipefail

# The cold load spawns `claude`, whose own Stop hook would spawn again.
if [[ -n "${PLUGIN_CHECK_RUNNING:-}" ]]; then
	exit 0
fi

command -v claude >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
cwd=$(jq -r '.cwd // empty' <<<"$input")
[[ -n "$cwd" && -d "$cwd" ]] || exit 0

# Walk up to the marketplace root; outside one, this hook has nothing to check.
repo="$cwd"
while [[ "$repo" != "/" && ! -f "$repo/.claude-plugin/marketplace.json" ]]; do
	repo=$(dirname "$repo")
done
[[ -f "$repo/.claude-plugin/marketplace.json" ]] || exit 0

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
