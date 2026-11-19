---
name: checkpoint
description: Save the durable knowledge of this session before /clear - rules to instruction files, facts to the kb store - and empty Claude Code's auto memory into them. Run only when the user types /kb:checkpoint.
argument-hint: "[auto memory folder]"
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(rm */projects/*/memory/*.md), Bash(echo *), Read, Glob, Edit, Write
---

# kb checkpoint

The user is about to run `/clear`. Save what a future session cannot get back from the code.
`kb` is on PATH. Run every `kb` command from the session's project directory, so scope and commit resolve.

## 1. Find what is worth a note

Sweep the whole session. Candidates:

- **gotcha** - something that surprised you or cost time, and will again.
- **decision** - a choice, with the reason and the alternative that lost.
- **convention** - a pattern of the code that a reader would miss, which you found in this session.
- **rule** - a rule the user stated or corrected you on. It goes to an instruction file, not to kb: see "Write a rule" below. Skip it when this session wrote it there already.
- **how-to** - a non-obvious procedure that worked.
- **open-work** - unfinished work. Write enough that a fresh session can resume: current state, the next step, the files, and what done looks like.

Skip a candidate when:

- a reader gets it from the code, the git history, or the repo's own docs
- it will be false next week (a temporary state, a one-time error, a version that changes soon)
- it only restates what you did, with no lesson

Never save a secret, token, password, key, or credential. Never save the content of a secret-bearing file. If a fact needs one, name where the value lives.

## 2. Search before you write

For each candidate, run `kb search --check <two or three key words>`: the nouns of the fact ("staging migration"), not a sentence.
It finds the notes that have every word, in any order. `--check` tells the log that the search is a check, not a need for a note.
Each note is one line, `id | scope | title`, with this repo first. A hit in another repo's scope does not cover this repo. Also check the notes injected at session start.

- A note already covers it and is still correct: skip it.
- A note covers it but is incomplete or wrong: update that note (pass its `id`). Read it with `kb show <id> --check`, so the log records a check.
- Nothing covers it: add a note. When the search missed a close note, `kb add` answers `neighbors` (step 3).

### Move Claude Code's auto memory into kb

kb replaces Claude Code's auto memory. Read one memory folder:

- With an argument (`/kb:checkpoint <path>/projects/<name>/memory`), read that folder only: $ARGUMENTS
- Without one, read the folder of this session's project: `<config>/projects/<name>/memory/`. `<config>` is `$CLAUDE_CONFIG_DIR`, or `~/.claude` when that is not set (run `echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"` for the absolute path). `<name>` is the absolute path of the session's directory, with each character that is not a letter or a digit changed to `-` (`/Users/u/my_app` gives `-Users-u-my-app`).

Read each `*.md` file in the folder except `MEMORY.md`. A folder that does not exist or has no files: skip this step.
In both cases `<name>` is the folder above `memory`. The folder belongs to this session's project when `<name>` is the session's directory as above, or the same path under an older home folder (`-Users-olduser-dev-app` for `/Users/user/dev/app`). Else its project is gone or elsewhere.

For each fact in it, apply the skip rules of step 1 first: a dated status, a finished plan or a one-time state is not worth a note. Then:

- It is a rule or a preference of the user (a feedback memory): treat it as a **rule**.
- It holds in every repo (a tool, a platform behavior): treat it as a candidate with the scope `"global"`, and search as above.
- It is about this session's project, and the folder belongs to it: treat it as a candidate with the scope `"repo"`.
- It is about another project: leave it, and list it under **Skipped**.

When kb or an instruction file holds the fact, after a write or because it was there already, remove the memory file with `rm <absolute path of the file>` (one file per command, never a glob or `-r`) and remove its line from that folder's `MEMORY.md`.
Remove nothing when the write failed, and leave the files you skipped. Never leave the same fact in two places.

### Write a rule

Run `kb instructions`. A rule about the user or how they work everywhere goes to the global file it prints. A rule about this repo only goes to the repo's `CLAUDE.md` or `AGENTS.md`, after the user says yes to the line.
Read the whole file. Change a rule that says something close, or add one short line at the end of the section that fits. Do not commit the change.
If a kb note holds the same rule, run `kb trash <id>`.

## 3. Write

One idea per note. Aim for a body under 15 lines: the fact, why it matters, how to apply it.
Write the title as a statement of the fact, not a topic ("Stripe signature check needs the raw body", not "Stripe webhooks").

Write one JSON object to a file with the Write tool. Use your scratchpad directory, or the system temp folder when you have none, and a new file name for each note:

```json
{
  "title": "Stripe signature check needs the raw body",
  "kind": "gotcha",
  "scope": "repo",
  "confidence": "high",
  "anchors": ["src/webhooks/stripe.ts#verifySignature", "src/server.ts"],
  "body": "express.json() runs before the webhook route and breaks the signature check.\nMount express.raw() on the webhook route before the JSON parser."
}
```

Then run `kb add`, one note per call. Write the whole path of the file in the command itself:

```bash
kb add --json --file /full/path/of/the/file.json
```

A session with normal permissions refuses a command that sets a shell variable, such as `D=<dir>; kb add --file $D/note.json`. It also refuses a heredoc that holds the JSON.

- `scope`: `"repo"` for a fact about this repository. `"global"` for a fact that holds in every repo (a tool, a user preference, a platform behavior).
- `kind`: `gotcha`, `decision`, `convention`, `how-to` or `open-work`.
- `confidence`: `high` when you verified it in this session, `medium` when it is likely, `low` when it is a guess.
- `anchors`: repo-relative paths, or `path#symbol`, of the code the fact depends on. They let a later check find stale notes. Leave the list empty for a global note.
- To update, add `"id": "<id>"` and only the fields that change. A `body` replaces the whole body, so read the note with `kb show <id> --check` first and write the full new body, with the old detail that is still true. A new title, body or anchors also records the note as verified now.

Read the result. `created` and `updated` are done. `exists` means a note in this scope has the same title: read it with `kb show <id> --check`, then update it or skip.

`neighbors` means that nothing was written: stored notes are close to the new note in their words. `shared` names the words both have. Read each neighbor with `kb show <id> --check`. Then write the file again and run the command again:

- A neighbor holds the same fact: update it. Pass its `id` and the full new body. Skip it when it lacks nothing.
- A neighbor says the opposite of the new fact: the two notes contradict. Update that note with what is true now. Do not add a second note.
- Each neighbor holds a different fact: add `"new": true` to the JSON.

## 4. Close finished work

For each `open-work` note that this session finished, run `kb trash <id>`. If part of the work remains, update the note to the new state.

## 5. Give a verdict on the notes you got

Run this:

```bash
kb log --session ${CLAUDE_SESSION_ID}
```

It prints the events of this session. Under `no verdict yet:` it lists each note you got and how: `body` (whole, at the session start), `opened` (you ran `kb show`) or `fired` (a hook named it when you read a file).
No such list means there is nothing to judge: go to step 6.

Give a verdict only for a note you can judge:

- `kb verdict helped <id>... --session ${CLAUDE_SESSION_ID}` - the note changed what you did.
- `kb verdict wrong <id>... --session ${CLAUDE_SESSION_ID}` - the note was false or misleading.
- `kb verdict not-needed <id>... --session ${CLAUDE_SESSION_ID}` - a hook named the note when you read a file (`fired`), and it had no bearing on the work.

Pass `--session ${CLAUDE_SESSION_ID}` on each verdict, so the verdict belongs to the session that the list above read.
Skip a note when you cannot tell. An index line gets no verdict.
Give `not-needed` only to a note that the list marks `fired`. kb refuses it for any other note.
A `body` loads in every session, and most sessions do not need it. It gets `helped`, `wrong` or no verdict.
A verdict `wrong` sends the note to the next audit.
Give no `wrong` to a note that this session corrected or rewrote: the correction is the record.

## 6. Record the checkpoint

Run this once, after the writes above succeed:

```bash
kb checkpointed ${CLAUDE_SESSION_ID}
```

It tells the session hooks that this session saved its knowledge. Skip it when a `kb` command failed.

## 7. Report

End with this, and nothing after it. Write it as Markdown, not in a code block, so it renders:

```
**Safe to clear** - <n> saved, <n> updated, <n> rules, <n> closed, <n> moved, <n> skipped

**Saved**
- **<title>**
  <what a future session loses without it>

**Updated**
- **<title>**
  <what changed in the note>

**Rules**
- **<rule>**
  <the file that holds it now>

**Closed**
- **<title>**
  <what finished the work>

**Moved from auto memory**
- **<title>**
  <new note or rule, or the place that already held it>

**Skipped:** <candidate> (<reason>), <candidate> (<reason>).
```

- The first line is the verdict. Write `**Safe to clear**`, or `**Not safe to clear** - <what is unsaved>` when a `kb` command failed, or when open work exists that no note describes. Never add "yes" or "no".
- Show the title of a note, not its id. Keep each reason to one short sentence.
- Leave out a count that is 0, and a group that is empty.
