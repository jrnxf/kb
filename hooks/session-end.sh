#!/bin/sh
# SessionEnd hook. Like session-start.sh: on any failure it prints nothing and exits 0.
command -v bun >/dev/null 2>&1 || exit 0
bun "$(dirname "$0")/session-end.ts" >/dev/null 2>&1 || true
exit 0
