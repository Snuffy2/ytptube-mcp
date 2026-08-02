#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

npx --yes npm-check-updates --upgrade
npm install --package-lock-only --ignore-scripts
prek update
