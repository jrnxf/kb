---
name: clear
description: Saves this session's knowledge as /kb:save does, then clears the session - but only when the save fully succeeded. Run only when the user types /kb:clear.
argument-hint: "[auto memory folder]"
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(rm */projects/*/memory/*.md), Bash(kb-transcript --memory), Read, Glob, Edit, Write
---

# kb clear

Read `<this skill's base directory>/../save/SKILL.md` and follow every step of it, with these arguments: $ARGUMENTS

When this turn ends, kb runs `/clear` by itself if all of these are true:

- `kb saved` ran in this turn and succeeded.
- Your answer starts with `**Safe to clear**`.
- The turn ended normally.

So:

- When a step needs the user's answer, such as a repo rule that waits for a yes, ask the question and stop. Write no report. The session then stays, and the user runs `/kb:clear` again after the answer.
- When the verdict is `**Not safe to clear**`, write it as the save skill says. The session then stays.
- Never write `**Safe to clear**` unless step 6 succeeded.
