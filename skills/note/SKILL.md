---
name: note
description: Write a rule, preference or correction to an instruction file (the global CLAUDE.md, or the repo's CLAUDE.md or AGENTS.md) in the same turn the user states it. Use when the user says always, never, from now on, I prefer, don't do that, remember this, or corrects how you work. Use it instead of Claude Code's auto memory and its MEMORY.md.
allowed-tools: Bash(kb *), Read, Edit, Write
---

# kb note

The user just stated a rule, a preference or a correction. Write it now, before you answer the rest. Do not wait for /kb:save.
A rule goes to an instruction file, which every session loads whole. kb keeps what agents learn (gotchas, decisions, how-tos, open work), not the user's rules.
`kb` is on PATH. Run every `kb` command from the session's project directory, so the repo resolves.
Never write it to Claude Code's auto memory (`~/.claude/projects/*/memory/`, `MEMORY.md`).

## 1. Find the file

Run `kb instructions`. It prints the global file and, in a repo, the repo's `CLAUDE.md` and `AGENTS.md`.

- A rule about the user or how they work everywhere (style, tools, how to reply): the global file. Use the path that `kb instructions` prints. It is the file at the end of the links, so an edit there reaches every session.
- A rule about this repository only: the repo's file. Use the file that exists. When both exist and `CLAUDE.md` only imports `AGENTS.md`, use `AGENTS.md`. When neither exists, use `CLAUDE.md`.

## 2. Merge it in

Read the whole file. Then:

- The file already says it: write nothing. Tell the user where it says it.
- A rule says something close, or the opposite: change that rule.
- Nothing covers it: add one line at the end of the section that fits. Add a section only when no section fits.

Write the rule as one short line in the style of the file around it: an instruction, not a story.
Keep it short. The file loads into every session, so each word costs context.
Never write a secret, token, password or credential.

For a repo file, show the user the line and the file first, and write only after they say yes. The repo file is shared with everyone who works in the repo. The global file belongs to the user: write it with no question.

Do not commit the change. The user commits it with their other work.

## 3. Clear old notes

Run `kb search --check <two or three key words>`, with the nouns of the rule. A word also finds its other forms: "retry" finds "retries".
If a kb note holds the same rule, run `kb trash <id>`, so the rule lives in one place. If a kb note says the opposite, trash it too: the rule the user just stated is what is true now.

## 4. Confirm

Say in one line which file now holds the rule. Then follow the rule from this turn on.
