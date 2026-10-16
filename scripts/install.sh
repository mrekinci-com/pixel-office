#!/usr/bin/env bash
# Only prepares repository-local files. Installs no packages and starts no services.
set -euo pipefail
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Usage: bash scripts/install.sh'
  printf '%s\n' 'Prepares local settings and prints startup commands.'
  exit 0
fi
if (( $# )); then
  printf '%s\n' 'Unknown option. Use --help for usage.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Install Node.js 24 or later first.' >&2
  exit 1
fi
exec node "$(dirname "$0")/install.mjs"
