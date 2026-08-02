#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

if ! command -v prek >/dev/null 2>&1; then
  echo "error: prek is required to update dependencies; install it from https://prek.j178.dev/installation/" >&2
  exit 1
fi

npx --yes npm-check-updates --upgrade
npm install --package-lock-only --ignore-scripts
prek update
