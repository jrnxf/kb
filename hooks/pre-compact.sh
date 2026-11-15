#!/bin/sh
# PreCompact hook. Its stdout becomes instructions for the compaction summary.
# The text is static, so this needs no bun and cannot fail.
cat <<'TEXT'
Keep these in the summary, in full, because they may not be saved anywhere else yet:
- gotchas and surprises found in this session, with the fix
- decisions, with the reason and the alternative that lost
- conventions and corrections the user stated
- unfinished work: the current state, the next step, and the files
- the ids of kb notes that changed what was done
TEXT
exit 0
