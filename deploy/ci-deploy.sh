#!/usr/bin/env bash
# Runs only on the project-specific shell Runner installed on the Master.
set -euo pipefail
[[ ${CI_COMMIT_BRANCH:-} == main ]] || { echo 'Production deployment requires main.' >&2; exit 1; }
[[ ${CI_COMMIT_SHA:-} =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA.' >&2; exit 1; }
# A queued older pipeline must not replace a newer main deployment.
latest=$(git ls-remote origin refs/heads/main 2>/dev/null | awk '{print $1}')
[[ "$latest" =~ ^[a-f0-9]{40}$ ]] || { echo 'Cannot verify current main revision.' >&2; exit 1; }
if [[ "$latest" != "$CI_COMMIT_SHA" ]]; then
  echo 'Skipping superseded pipeline; main has a newer revision.'
  exit 0
fi
sudo -n /usr/local/sbin/blink-node-deploy "$CI_COMMIT_SHA"
