#!/usr/bin/env bash
# Setup script of this repository's cloud environment, which .github/factory/environment.json declares.
#
# claude.ai keeps its own copy and nothing syncs the two: after a change here, the owner loads this file again in
# the environment's settings, under Setup script. It runs as root before Claude Code starts, with the environment's
# variables unset, and its filesystem is cached for the sessions that follow.
#
# It installs what a session cannot install for itself: system packages, and mise. The tools of mise.toml need the
# clone: .claude/hooks/cloud-tools.sh installs them when a session starts.
#
# A non-zero exit keeps every session of the environment from starting, so a failure is logged to
# ~/.cloud-env-setup.log and the script exits 0.
set -uo pipefail

readonly MISE_VERSION="2026.11.2"
readonly MISE_SHA256="c914dc3be1ad3588c3a7fa8ddae86c65e77eaf1777aa4a900c215e467f4c94a4"

readonly BIN_DIR="${HOME}/.local/bin"
readonly MISE_CONFIG="${HOME}/.config/mise"
WORKDIR="$(mktemp -d)"
readonly WORKDIR
trap 'rm -rf -- "${WORKDIR}"' EXIT

log() {
  printf '[cloud-setup] %s\n' "$*"
}

# The agent-docs-drift tests sign a commit with ssh-keygen, which the image does not ship.
install_packages() {
  DEBIAN_FRONTEND=noninteractive apt-get update --quiet &&
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --quiet --no-install-recommends openssh-client
}

install_mise() {
  curl --fail --silent --show-error --location --retry 3 --max-time 120 \
    --output "${WORKDIR}/mise.tar.gz" \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.gz" &&
    printf '%s  %s\n' "${MISE_SHA256}" "${WORKDIR}/mise.tar.gz" | sha256sum --check --status &&
    tar -xzf "${WORKDIR}/mise.tar.gz" -C "${WORKDIR}" mise/bin/mise &&
    install -m 0755 "${WORKDIR}/mise/bin/mise" "${BIN_DIR}/mise"
}

# A locked install takes each download from mise.lock: the session's GitHub proxy refuses the API calls that would
# resolve a version. The image ships Claude Code, which mise.toml pins for the workstation and CI.
write_mise_settings() {
  cat >"${MISE_CONFIG}/config.toml" <<'EOF'
[settings]
locked = true
yes = true
trusted_config_paths = ["/"]
disable_tools = ["claude"]
EOF
}

# What .claude/hooks/cloud-tools.sh compares with the file in the clone. claude.ai drops the file's final newline, so
# both sides digest the text without it.
write_revision() {
  [[ -f ${BASH_SOURCE[0]} ]] || return 1

  local text sum
  text=$(<"${BASH_SOURCE[0]}") || return 1
  sum=$(printf '%s' "${text}" | sha256sum) || return 1
  printf '%s\n' "${sum%% *}" >"${HOME}/.cloud-env-setup.revision"
}

main() {
  mkdir -p "${BIN_DIR}" "${MISE_CONFIG}"
  install_packages || log "FAILED  apt-get install openssh-client"
  install_mise || log "FAILED  mise ${MISE_VERSION}: download or checksum"
  write_mise_settings || log "FAILED  writing ${MISE_CONFIG}/config.toml"
  write_revision || log "FAILED  recording the script's revision: it does not run from a file"
  log "done"
}

main 2>&1 | tee "${HOME}/.cloud-env-setup.log"
exit 0
