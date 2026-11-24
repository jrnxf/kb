#!/bin/sh
# PostToolUse hook on Read. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch.
. "$(dirname "$0")/bun.sh"
[ -n "$BUN" ] || exit 0
"$BUN" "$(dirname "$0")/post-read.ts" 2>/dev/null || true
exit 0
