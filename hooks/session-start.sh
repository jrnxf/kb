#!/bin/sh
# SessionStart hook. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch.
command -v bun >/dev/null 2>&1 || exit 0
bun "$(dirname "$0")/session-start.ts" 2>/dev/null || true
exit 0
