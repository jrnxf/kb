#!/bin/sh
# SessionStart hook. It must never break or slow a session: on any failure it prints
# nothing and exits 0. A missing bun is the one failure only a shell can catch, and the one
# failure the user hears of: this hook alone says, in one line, that kb is off. It says so on
# a startup or a resume, and only when a person is there. A /clear, a compaction or a fork keeps
# the session the user already saw the line in. The other hooks stay silent.
d=$(dirname "$0")
# A bun.sh that is missing (a half-done update) must not stop the hook: a failed . exits 2 in dash.
[ -r "$d/bun.sh" ] && . "$d/bun.sh"
if ! kb_need_bun; then
  case ${CLAUDE_CODE_ENTRYPOINT-} in sdk*) exit 0 ;; esac
  [ -n "${BUN_MISSING-}" ] || exit 0
  # The input is one line of JSON. Plain sh reads it, as there is no bun to parse it.
  input=
  while IFS= read -r line || [ -n "$line" ]; do input="$input$line"; done
  source=$(printf '%s' "$input" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  case $source in
    startup | resume)
      printf '{"systemMessage":"kb: %s"}\n' "$BUN_MISSING"
      ;;
  esac
  exit 0
fi
"$BUN" "$d/session-start.ts" 2>/dev/null || true
exit 0
