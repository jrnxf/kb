---
name: checkpoint
description: The old name of /kb:save. Saves this session's knowledge and does not clear. Run only when the user types /kb:checkpoint.
argument-hint: "[auto memory folder]"
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(rm */projects/*/memory/*.md), Bash(kb-transcript --memory), Read, Glob, Edit, Write
---

# kb checkpoint

`/kb:checkpoint` is now `/kb:save`. Tell the user that in one line.
Then read `<this skill's base directory>/../save/SKILL.md` and follow every step of it, with these arguments: $ARGUMENTS
