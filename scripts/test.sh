#!/usr/bin/env sh

set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir/.."

npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
