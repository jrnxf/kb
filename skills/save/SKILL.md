---
name: save
description: Save the durable knowledge of this session before /clear - rules to instruction files, facts to the kb store - and empty Claude Code's auto memory into them. Run only when the user types /kb:save, or when /kb:clear or /kb:checkpoint sends you here.
argument-hint: "[auto memory folder]"
disable-model-invocation: true
allowed-tools: Bash(kb *), Bash(rm */projects/*/memory/*.md), Bash(kb-transcript --memory), Read, Glob, Edit, Write
---

# kb save

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
  - Open work goes to the repo it belongs to: save it there with the scope `"repo"`. Outside any repo it is `"global"`.
  - In a repo, never save open work as `"global"`: a session start shows the next step only for the open work of its own repo.
  - Give the body one line that starts with `Next:` and names the next step. A session start shows that line, and `kb show` gives the rest. For several steps, write `Next:` on its own line and a list below it.
  - Put no date in the title. kb records when the note was verified.

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

- With an argument (`/kb:save <path>/projects/<name>/memory`), read that folder only: $ARGUMENTS
- Without one, run `kb-transcript --memory` from the session's directory. It prints the folder of this session's project and its files as JSON: `{"folder", "files"}`. `files` has the absolute path of each `*.md` file but `MEMORY.md`. Do not find the folder with another command: in the default permission mode, Claude Code asks before a command with a variable, or a list of a folder outside the project.

Read each `*.md` file in the folder except `MEMORY.md`, with the Read tool. A folder that does not exist or has no files: skip this step.
In both cases `<name>` is the folder above `memory`. Claude Code names it after the absolute path of the project, with each character that is not a letter or a digit changed to `-` (`/Users/u/my_app` gives `-Users-u-my-app`). The folder belongs to this session's project when `<name>` is the session's directory, or the same path under an older home folder (`-Users-olduser-dev-app` for `/Users/user/dev/app`). Else its project is gone or elsewhere.

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

One idea per note. Aim for a body of 700 characters or fewer: the fact, why it matters, how to apply it. A trigger loads 700 characters and cuts the rest.
Write the title as a statement of the fact, not a topic ("Stripe signature check needs the raw body", not "Stripe webhooks").
For a gotcha about a command or an error, put the command or the error word in the title.

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
- `triggers`: when the note loads outside the session start. See "Say when the note loads" below.
- To update, add `"id": "<id>"` and only the fields that change. A `body` replaces the whole body, so read the note with `kb show <id> --check` first and write the full new body, with the old detail that is still true. A new title, body or anchors also records the note as verified now.

### Say when the note loads

A note at the session start is one title among many, hours before the agent needs it.
A trigger or an anchor loads the note at the moment it applies.
Give every `gotcha` and every `how-to` a trigger or an anchor. When none fits, say why in one line of the report.

- A gotcha about a command gets `"triggers": ["cmd: pkill -f"]`. The note loads at a shell command that runs those words. The command still runs, and the agent gets the note with its result.
- When one run of the command does damage, write `stop:` in place of `cmd:`. kb then refuses the command once, with the note as the reason. A run 3 seconds later passes.
- A gotcha about an error gets `"triggers": ["err: address already in use"]`. Use the stable part of the error text, at least 8 characters. Leave out a path, an id or a number that changes.
- A fact about a file gets an anchor. The note loads when the agent reads or changes that file.
- A note can have several triggers, and triggers and anchors together.

A `cmd:` or a `stop:` trigger is the words of the command, in order: `cmd: git push --force`.
One command of the line must hold them as whole words, with the first as its command word. Other words may stand between them.
kb refuses one word that is a common command (`git`, `ls`, `bun`): add a subcommand or a flag.
`-rf` and `-fr` are two words, so give one trigger for each form.

Read the result. `created` and `updated` are done. `exists` means a note in this scope has the same title: read it with `kb show <id> --check`, then update it or skip.
A result can hold `warnings`: a gotcha or a how-to with no trigger and no anchor, open work that a repo session saved as `"global"`, or a body over 700 characters. The note is saved. Fix it with an update, or give the reason in the report.

`neighbors` means that nothing was written: stored notes are close to the new note in their words. `shared` names the words both have.
`kb add` exits with code 2 for this answer, so the call shows as failed. It is an answer to read, not a failure of the tool. The note is not saved until you run the command again.
Read each neighbor with `kb show <id> --check`. Then write the file again and run the command again:

- A neighbor holds the same fact: update it. Pass its `id` and the full new body, and remove `scope` from the JSON. An update keeps the scope of the note. Skip it when it lacks nothing.
- A neighbor says the opposite of the new fact: the two notes contradict. Update that note with what is true now. Do not add a second note.
- Each neighbor holds a different fact: add `"new": true` to the JSON.
- A neighbor is in another scope than the new fact, such as a `global` note for a fact about this repo: update it only when the fact holds in that scope too. For a global note, that means in every repo. Else add `"new": true`. Never put a fact about one repo into a global note.

## 4. Close finished work

For each `open-work` note that this session finished, run `kb trash <id>`. If part of the work remains, update the note to the new state, with a new `Next:` line.

## 5. Give a verdict on the notes you got

Run this:

```bash
kb log --session ${CLAUDE_SESSION_ID}
```

It prints the events of this session. Under `no verdict yet:` it lists each note you got and how: `brief` (open work, at the session start), `body` (whole, at the session start), `opened` (you ran `kb show`) or `fired` (a trigger loaded it: a command, an error or a file).
No such list means there is nothing to judge: go to step 6.

Give a verdict only for a note you can judge:

- `kb verdict helped <id>... --session ${CLAUDE_SESSION_ID}` - the note changed what you did.
- `kb verdict wrong <id>... --session ${CLAUDE_SESSION_ID}` - the note was false or misleading.
- `kb verdict not-needed <id>... --session ${CLAUDE_SESSION_ID}` - a trigger loaded the note (`fired`), and it had no bearing on the work.

Pass `--session ${CLAUDE_SESSION_ID}` on each verdict, so the verdict belongs to the session that the list above read.
Skip a note when you cannot tell. An index line gets no verdict.
Give `not-needed` only to a note that the list marks `fired`. kb refuses it for any other note.
A `brief` or a `body` loads in every session, and most sessions do not need it. It gets `helped`, `wrong` or no verdict.
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
- Under a saved gotcha or how-to that has no trigger and no anchor, add one line: `No trigger: <why none fits>`.
- Leave out a count that is 0, and a group that is empty.
