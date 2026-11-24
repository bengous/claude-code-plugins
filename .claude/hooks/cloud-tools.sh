#!/usr/bin/env bash
# SessionStart, in a cloud session alone: installs the tools mise.lock records, which the environment's setup script
# cannot do before the clone exists, and says so when the environment did not run .github/factory/setup.sh as the
# clone holds it. What it prints reaches the session as context. Never blocks the session.
set -uo pipefail

[[ ${CLAUDE_CODE_REMOTE:-} == true ]] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

readonly SETUP=.github/factory/setup.sh
readonly BIN_DIR="${HOME}/.local/bin"

# claude.ai drops the final newline of the copy it runs, so both sides digest the text without it.
text=$(<"${SETUP}")
expected=$(printf '%s' "${text}" | sha256sum | cut -d ' ' -f 1)
ran=$(cat "${HOME}/.cloud-env-setup.revision" 2>/dev/null)
if [[ ${ran} != "${expected}" ]]; then
  echo "This cloud environment did not run ${SETUP} as this clone holds it (ran: ${ran:-none}). A tool or a package the script installs may be missing: the owner loads the file again in the environment's settings on claude.ai."
fi

if ! command -v mise >/dev/null 2>&1; then
  echo "mise is not installed in this cloud environment, so the tools of mise.toml were not installed."
  exit 0
fi

if ! output=$(mise install 2>&1); then
  echo "mise install failed, so a tool of mise.toml may be missing or at the image's version:"
  tail -n 20 <<<"${output}"
  exit 0
fi

mise reshim
mkdir -p "${BIN_DIR}"
for shim in "${HOME}/.local/share/mise/shims/"*; do
  [[ -e ${shim} ]] && ln -sf "${shim}" "${BIN_DIR}/"
done
exit 0
