---
name: checkpoint
description: Save the durable knowledge of this session to the kb store before /clear. Run only when the user types /kb:checkpoint.
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(rm *), Bash(echo *), Read, Glob, Edit
---

# kb checkpoint

The user is about to run `/clear`. Save what a future session cannot get back from the code.
`kb` is on PATH. Run every `kb` command from the session's project directory, so scope and commit resolve.

## 1. Find what is worth a note

Sweep the whole session. Candidates:

- **gotcha** - something that surprised you or cost time, and will again.
- **decision** - a choice, with the reason and the alternative that lost.
- **convention** - a rule the user corrected you on or stated.
- **how-to** - a non-obvious procedure that worked.
- **open-work** - unfinished work. Write enough that a fresh session can resume: current state, the next step, the files, and what done looks like.

Skip a candidate when:

- a reader gets it from the code, the git history, or the repo's own docs
- it will be false next week (a temporary state, a one-time error, a version that changes soon)
- it only restates what you did, with no lesson

Never save a secret, token, password, key, or credential. Never save the content of a secret-bearing file. If a fact needs one, name where the value lives.

## 2. Search before you write

For each candidate, run `kb search <two or three key words>`. It finds the notes that have every word, in any order.
Each note is one line, `id | scope | title`, with the notes of this repo first. A hit in another repo's scope does not cover this repo.
Use the nouns of the fact ("staging migration"), not a sentence. Also check the notes injected at session start.
When the answer starts with `no note has every word. Closest:`, read those notes too: one of them can be the same fact in other words.

- A note already covers it and is still correct: skip it.
- A note covers it but is incomplete or wrong: update that note (pass its `id`).
- Nothing covers it: add a note.

### Move Claude Code's auto memory into kb

kb replaces Claude Code's auto memory. Its folders are `<config>/projects/*/memory/`, where `<config>` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is not set.
Run `echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` to get the absolute path. List the files with Glob `<that path>/projects/*/memory/*.md`, and read each one except `MEMORY.md`.
The folder of this session's project has the project path as its name, with each `/` and `.` changed to `-`.

For each fact in it:

- It holds in every repo (a user preference, a feedback rule, a tool): treat it as a candidate with the scope `"global"`, and search as above.
- It is about this session's project: treat it as a candidate with the scope `"repo"`.
- It is about another project: leave it, and list it under **Skipped** with the folder name.

When kb holds the fact, after a write or because a note already covered it, remove the memory file with `rm` and remove its line from that folder's `MEMORY.md`.
Remove nothing when the `kb` write failed. Never leave the same fact in both stores.

## 3. Write

One idea per note. Aim for a body under 15 lines: the fact, why it matters, how to apply it.
Write the title as a statement of the fact, not a topic ("Stripe signature check needs the raw body", not "Stripe webhooks").

Pipe one JSON object to `kb add --json`. Use a quoted heredoc, so the shell changes nothing:

```bash
kb add --json <<'KB_NOTE'
{
  "title": "Stripe signature check needs the raw body",
  "kind": "gotcha",
  "scope": "repo",
  "confidence": "high",
  "anchors": ["src/webhooks/stripe.ts#verifySignature", "src/server.ts"],
  "body": "express.json() runs before the webhook route and breaks the signature check.\nMount express.raw() on the webhook route before the JSON parser."
}
KB_NOTE
```

- `scope`: `"repo"` for a fact about this repository. `"global"` for a fact that holds in every repo (a tool, a user preference, a platform behavior).
- `kind`: `gotcha`, `decision`, `convention`, `how-to` or `open-work`.
- `confidence`: `high` when you verified it in this session, `medium` when it is likely, `low` when it is a guess.
- `anchors`: repo-relative paths, or `path#symbol`, of the code the fact depends on. They let a later check find stale notes. Leave the list empty for a global note.
- To update, add `"id": "<id>"` and only the fields that change. A `body` replaces the whole body, so read the note with `kb show <id>` first and write the full new body, with the old detail that is still true. A new title, body or anchors also records the note as verified now.

Read the result. `created` and `updated` are done. `exists` means a note in this scope has the same title: read it with `kb show <id>`, then update it or skip.

## 4. Close finished work

For each `open-work` note that this session finished, run `kb trash <id>`. If part of the work remains, update the note to the new state.

## 5. Record what helped

Run `kb use <id>...` once, with the ids of the injected or shown notes that changed what you did in this session. Do not list notes you only read. This is the only usefulness signal the store has.

## 6. Record the checkpoint

Run this once, after the writes above succeed:

```bash
kb checkpointed ${CLAUDE_SESSION_ID}
```

It tells the session hooks that this session saved its knowledge. Skip it when a `kb` command failed.

## 7. Report

End with this, and nothing after it. Write it as Markdown, not in a code block, so it renders:

```
**Safe to clear** - <n> saved, <n> updated, <n> closed, <n> moved, <n> skipped

**Saved**
- **<title>**
  <what a future session loses without it>

**Updated**
- **<title>**
  <what changed in the note>

**Closed**
- **<title>**
  <what finished the work>

**Moved from auto memory**
- **<title>**
  <new note, or the note that already held it>

**Skipped:** <candidate> (<reason>), <candidate> (<reason>).
```

- The first line is the verdict. Write `**Safe to clear**`, or `**Not safe to clear** - <what is unsaved>` when a `kb` command failed, or when open work exists that no note describes. Never add "yes" or "no".
- Show the title of a note, not its id. Keep each reason to one short sentence.
- Leave out a count that is 0, and a group that is empty.
