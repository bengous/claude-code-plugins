#!/usr/bin/env bash
# Probes the current project for Effect adoption signals.
# Called via !`command` preprocessing when the skill loads.
# Outputs XML to <null-as-error-context>.
set -euo pipefail

require() {
	command -v "$1" > /dev/null 2>&1 || {
		printf '<null-as-error-context error="missing dependency: %s" />\n' "$1"
		exit 0
	}
}

require jq
require rg

xml_escape() {
	local s="${1//&/&amp;}"
	s="${s//</&lt;}"
	s="${s//>/&gt;}"
	printf '%s' "${s}"
}

if [[ ! -f package.json ]]; then
	cat <<'XML'
<null-as-error-context effect="false">
  <reason>No package.json found -- not a Node/Bun project.</reason>
</null-as-error-context>
XML
	exit 0
fi

raw_v=$(jq -r '.dependencies.effect // .devDependencies.effect // "none"' package.json) || true
v=$(xml_escape "${raw_v}")

if [[ "${raw_v}" == "none" ]]; then
	cat <<XML
<null-as-error-context effect="false">
  <reason>Effect is not in dependencies. Scanner will not find Effect-specific patterns.</reason>
</null-as-error-context>
XML
	exit 0
fi

rg_opts=(--type ts -l --no-messages --max-depth 20)

# Explicit "." required: without a path arg, rg may read stdin in pipe context.
n=$(rg "${rg_opts[@]}" "from ['\"]effect" . 2> /dev/null | wc -l | tr -d ' ') || true
catch_all=$(rg "${rg_opts[@]}" 'catchAll\(' . 2> /dev/null | wc -l | tr -d ' ') || true

cat << XML
<null-as-error-context effect="true">
  <version>${v}</version>
  <files-importing-effect>${n}</files-importing-effect>
  <files-with-catchAll>${catch_all}</files-with-catchAll>
</null-as-error-context>
XML
