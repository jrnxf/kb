#!/bin/sh
# Stands in for `claude -p` in the tests. FAKE_AUDIT says what it does.
# It first runs a bare `kb audit`, as the skill does, to show that an agent never starts another agent.
kb audit > "$FAKE_OUT/status.txt" 2>&1
case "$FAKE_AUDIT" in
  propose) printf '%s' "$FAKE_ITEMS" | kb audit propose ;;
  nothing) echo "every note still holds" ;;
  slow) sleep 30 ;;
  *) echo "boom"; exit 3 ;;
esac
