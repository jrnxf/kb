#!/usr/bin/env bash
# Runs the hooks-module test with `claude plugin test`. That command loads every
# *.test.ts in the folder it gets, and the bun tests in test/ do not load there,
# so this copies the plugin without test/ into a temp folder first.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
mkdir -p "$dir/hooks"
cp -R "$root/.claude-plugin" "$dir/"
cp "$root"/hooks/hooks.json "$root"/hooks/clear-after-save*.ts "$dir/hooks/"
claude plugin test "$dir"
