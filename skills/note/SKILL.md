---
name: note
description: Save a rule, preference or correction to kb in the same turn the user states it. Use when the user says always, never, from now on, I prefer, don't do that, remember this, or corrects how you work. Use it instead of Claude Code's auto memory and its MEMORY.md.
allowed-tools: Bash(kb *)
---

# kb note

The user just stated a rule, a preference or a correction. Save it now, before you answer the rest. Do not wait for /kb:checkpoint.
`kb` is on PATH. Run every `kb` command from the session's project directory, so the scope resolves.
Never write it to Claude Code's auto memory (`~/.claude/projects/*/memory/`, `MEMORY.md`). kb replaces it.

## 1. Search

Run `kb search <two or three key words>`, with the nouns of the rule ("portuguese replies", not a sentence).
Also check the notes injected at session start.

- A note already says it: skip the write. Tell the user which note holds it.
- A note says something close, or the opposite: update that note. Read it with `kb show <id>` first.
- Nothing covers it: add a note.

## 2. Write

Write the title as the rule itself ("Reply to the user in Portuguese", not "Language").
The body says the rule, the user's own words when they are short, and the date in Europe/Lisbon time.

```bash
kb add --json <<'KB_NOTE'
{
  "title": "Reply to the user in Portuguese",
  "kind": "convention",
  "scope": "global",
  "confidence": "high",
  "body": "The user said \"ALWAYS ADDRESS ME IN PORTUGUESE\" on 2026-11-17 (Tuesday).\nWrite every reply in Portuguese, in every repo."
}
KB_NOTE
```

- `kind`: `convention` for a rule or a preference. `decision` for a choice with a reason.
- `scope`: `"global"` for a rule about the user or how they work everywhere. `"repo"` for a rule about this repository only.
- `confidence`: `high`, because the user said it.
- To update, pass `"id"` and only the fields that change. A `body` replaces the whole body.
- `exists` in the result means a note in this scope has the same title. Read it with `kb show <id>`, then update it or skip.

Never save a secret, token, password or credential.

## 3. Confirm

Say in one line that the rule is saved in kb, with the note title. Then follow the rule from this turn on.
