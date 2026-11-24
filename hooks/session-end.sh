#!/bin/sh
# SessionEnd hook. Like session-start.sh: on any failure it prints nothing and exits 0.
. "$(dirname "$0")/bun.sh"
[ -n "$BUN" ] || exit 0
"$BUN" "$(dirname "$0")/session-end.ts" >/dev/null 2>&1 || true
exit 0
