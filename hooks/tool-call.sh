#!/bin/sh
# PreToolUse hook on Bash, Edit, Write and NotebookEdit, and PostToolUseFailure hook. It must never
# break or slow a session: on any failure it prints nothing and exits 0. A missing bun is the one
# failure only a shell can catch.
command -v bun >/dev/null 2>&1 || exit 0
bun "$(dirname "$0")/tool-call.ts" 2>/dev/null || true
exit 0
