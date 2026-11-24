#!/bin/sh
# SessionEnd hook. Like session-start.sh: on any failure it prints nothing and exits 0.
d=$(dirname "$0")
# A bun.sh that is missing (a half-done update) must not stop the hook: a failed . exits 2 in dash.
[ -r "$d/bun.sh" ] && . "$d/bun.sh"
kb_need_bun || exit 0
"$BUN" "$d/session-end.ts" >/dev/null 2>&1 || true
exit 0
