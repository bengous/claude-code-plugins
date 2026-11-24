#!/usr/bin/env bash
# SessionStart, in a cloud session alone: installs the tools .github/factory/mise.lock records, which the
# environment's setup script cannot do before the clone exists, and says so when the environment did not run
# .github/factory/setup.sh as the clone holds it. What it prints reaches the session as context. Never blocks the session.
set -uo pipefail

[[ ${CLAUDE_CODE_REMOTE:-} == true ]] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

readonly SETUP=.github/factory/setup.sh
# The directory of the cloud's mise.toml and of its lockfile: mise reads the config of the directory it runs in.
readonly TOOLS=.github/factory
readonly BIN_DIR="${HOME}/.local/bin"

# claude.ai drops the final newline of the copy it runs, so both sides digest the text without it.
text=$(<"${SETUP}")
expected=$(printf '%s' "${text}" | sha256sum | cut -d ' ' -f 1)
ran=$(cat "${HOME}/.cloud-env-setup.revision" 2>/dev/null)
if [[ ${ran} != "${expected}" ]]; then
  echo "This cloud environment did not run ${SETUP} as this clone holds it (ran: ${ran:-none}). A tool or a package the script installs may be missing: the owner loads the file again in the environment's settings on claude.ai."
fi

if ! command -v mise >/dev/null 2>&1; then
  echo "mise is not installed in this cloud environment, so the tools of ${TOOLS}/mise.toml were not installed."
  exit 0
fi

# A locked install takes each download from the lockfile: the session's GitHub proxy refuses the API calls that would
# resolve a version.
if ! output=$(cd "${TOOLS}" && mise install --locked 2>&1); then
  echo "mise install failed in ${TOOLS}, so a tool may be missing or at the image's version:"
  tail -n 20 <<<"${output}"
  exit 0
fi

mise reshim
mkdir -p "${BIN_DIR}"
for shim in "${HOME}/.local/share/mise/shims/"*; do
  [[ -e ${shim} ]] && ln -sf "${shim}" "${BIN_DIR}/"
done
exit 0
