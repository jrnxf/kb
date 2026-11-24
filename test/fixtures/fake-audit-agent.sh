#!/bin/sh
# Stands in for `claude -p` in the tests. FAKE_AUDIT says what it does.
# It first runs a bare `kb audit`, as the skill does, to show that an agent never starts another agent.
kb audit > "$FAKE_OUT/status.txt" 2>&1
pwd -P > "$FAKE_OUT/cwd.txt"
# The arguments claude would get, one per NUL.
printf '%s\0' "$@" > "$FAKE_OUT/args.bin"
if git rev-parse 2>/dev/null; then echo repo; else echo none; fi > "$FAKE_OUT/git.txt"
case "$FAKE_AUDIT" in
  propose) printf '%s' "$FAKE_ITEMS" | kb audit propose ;;
  nothing) echo "every note still holds" ;;
  slow) sleep 30 ;;
  *) echo "boom"; exit 3 ;;
esac
