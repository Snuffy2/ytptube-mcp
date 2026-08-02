#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

npx --yes npm-check-updates --upgrade
npm install --package-lock-only --ignore-scripts

if command -v prek >/dev/null 2>&1; then
  prek update
else
  echo "warning: prek is unavailable; skipped hook updates. Install it from https://prek.j178.dev/installation/" >&2
fi
