---
name: recover
description: Save the knowledge of earlier sessions that ended with /clear before /kb:checkpoint ran, from their transcripts. Run only when the user types /kb:recover.
argument-hint: "[forget]"
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(bun *), Read, Agent
---

# kb recover

An earlier session in this project ended with `/clear` and no `/kb:checkpoint`. Its transcript is still on disk. Save what it learned, as a checkpoint would have.
`kb` is on PATH. Run every `kb` command from this session's project directory.

## 1. List the sessions

Run `kb unsaved --json`. Each entry has `session`, `transcript`, `cwd` and `ended`. An empty list: say there is nothing to recover, and stop.

With the argument `forget`, run `kb unsaved --forget <session>` for each entry, say how many you forgot, and stop.

## 2. Read each conversation

For each entry, run:

```bash
bun <this skill's base directory>/../../hooks/transcript.ts <transcript>
```

It writes what the user and the agent said to a temp file, without tool calls or tool output, and prints `{"file", "prompts", "chars"}`.

## 3. Save its knowledge in a subagent

For each entry, oldest first, start one subagent with the Agent tool: `subagent_type` `general-purpose`, `model` `sonnet`. One at a time, so two never write the same note. Give it this prompt, with the values filled in:

> An earlier Claude Code session ended before it saved its knowledge to kb. Do its checkpoint now.
> Its conversation is in `<file>` (Read it whole, in parts if it is long). It ran in `<cwd>`, and ended `<ended>`.
> Follow steps 1, 2, 3, 4 and 7 of `<this skill's base directory>/../checkpoint/SKILL.md`. Skip "Move Claude Code's auto memory into kb", "Write a rule", step 5 and step 6.
> Pass `--repo <cwd>` to every `kb add` and `kb search`.
> Write no instruction file. For a rule the user stated, write nothing: list it in the report under **Rules**, with the rule as one line and the words "not written".
> The session is old. Later sessions can have saved the same facts or finished its work. Search before every write, and check `git -C <cwd> log --oneline -20` before you save open work.
> The conversation leaves out tool output, so a fact you cannot confirm from it gets `"confidence": "medium"` at most.
> When `kb add` refuses a note because of a secret, write a placeholder for the secret. Never look for a way around the refusal.
> When no `kb` command failed, run `kb checkpointed <session>`. Run it also when nothing was worth a note.
> End with the step 7 report, and nothing after it.

## 4. Report

Show each subagent's report as it gave it, under a heading with the date the session ended.
When a subagent did not run `kb checkpointed`, say which session is still unsaved and why.

When a report lists rules, ask the user which of them still hold. The session is old, and the user can have changed their mind.
Write each rule the user confirms as /kb:note does: `kb instructions` names the file, and one short line goes in it.
