#!/bin/sh
# SessionStart hook. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch, and the one
# failure the user hears of: this hook alone says, in one line, that kb is off. It says so on
# startup only. A /clear, a compaction, a resume or a fork keeps the session the user already
# saw the line in. The other hooks stay silent.
. "$(dirname "$0")/bun.sh"
if [ -z "$BUN" ]; then
  # The input is one line of JSON. Plain sh reads it, as there is no bun to parse it.
  input=
  while IFS= read -r line || [ -n "$line" ]; do input="$input$line"; done
  case $input in
    *'"source":"startup"'* | *'"source": "startup"'*)
      printf '{"systemMessage":"kb: %s"}\n' "$BUN_MISSING"
      ;;
  esac
  exit 0
fi
"$BUN" "$(dirname "$0")/session-start.ts" 2>/dev/null || true
exit 0
