#!/bin/sh
# SessionStart hook. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch, and the one
# failure the user hears of: this hook alone says, in one line, that kb is off. The other hooks stay silent.
. "$(dirname "$0")/bun.sh"
if [ -z "$BUN" ]; then
  printf '{"systemMessage":"%s"}\n' "$BUN_MISSING"
  exit 0
fi
"$BUN" "$(dirname "$0")/session-start.ts" 2>/dev/null || true
exit 0
