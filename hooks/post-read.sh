#!/bin/sh
# PostToolUse hook on Read. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch.
d=$(dirname "$0")
# A bun.sh that is missing (a half-done update) must not stop the hook: a failed . exits 2 in dash.
[ -r "$d/bun.sh" ] && . "$d/bun.sh"
kb_need_bun || exit 0
"$BUN" "$d/post-read.ts" 2>/dev/null || true
exit 0
