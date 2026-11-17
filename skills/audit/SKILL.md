---
name: audit
description: Check the kb notes of this repo for stale, duplicate and over-budget entries, propose changes, and apply the ones the user accepts. Run only when the user types /kb:audit.
disable-model-invocation: true
allowed-tools: Bash(kb *)
model: opus
effort: medium
---

# kb audit

Keep the store true and small. You propose changes. The user accepts them. Then you apply them.
`kb` is on PATH. Run every `kb` command from the session's project directory, so scope and commit resolve.

## 1. Collect

```bash
kb stale --json
kb budget --json
```

- `kb stale` lists candidates for the current repo and for `global`. Each has a `reason`:
  - `anchor-changed` - an anchored file changed since the note was verified.
  - `anchor-missing` - an anchored path is gone, or the symbol is no longer in the file.
  - `commit-unknown` - the verified commit is not in the history (a rebase or a shallow clone).
  - `decayed` - nobody verified the note within the decay window.
  - `duplicate` - the title is close to the title of another note.
- `kb budget` shows what a session of this repo loads. `notes` gives the size and the use count of each note.
  - Bodies that did not fit (`context.dropped`) are normal: each of these notes still reaches the session as an index line. This alone is no reason to demote. The notes with the most `chars` are the bodies to shorten, so that more notes load whole.
  - `over` is true only when notes reach no session, because the index is full (`index.hidden`). Then `demote` lists as many notes as are hidden, least used first. Treat each one as a candidate too.
  - `demote` can list a `gotcha` or a `convention`. The rules in step 2 still apply to it.
  - `demoted` lists the notes that an earlier audit took out of every session.

A candidate is a reason to look, not a verdict. If `kb stale` has no candidate and `over` is false, say so and stop.

## 2. Judge each candidate

Read the note with `kb show <id>`. For an anchor reason, read the anchored code as it is now. Then choose one action:

| Action | When |
|---|---|
| verify | The note is still true as written. |
| rewrite | The fact drifted. The note needs a new body, title or anchors. |
| trash | The fact is obsolete, the work is done, or the user no longer needs the note. `kb restore` brings it back. The trash deletes it after 30 days. |
| delete | The user asks for a note to be gone now. There is no undo in kb. Never choose this yourself. |
| merge | Two or more notes cover one idea. One note keeps everything, the others go to the trash. |
| shorten | The note is true but long. Cut it to the fact, the reason and how to apply it. |
| demote | The note is true but rarely used, and `over` is true. No session loads it again. It stays searchable. |
| keep | Nothing to do. Use this for a `duplicate` candidate that is in fact a different idea. |

Rules:

- Do not verify a note you did not check against the code or a source. For a `global` note with no anchor, verify only when you know the fact still holds. If you cannot tell, propose `keep` and say what is unknown.
- Demote only when `over` is true, and at most as many notes as `demote` lists. Prefer merge, trash and shorten before demote. Never demote `open-work`.
- A demoted note leaves every session without a trace there. So never demote a `gotcha` or a `convention` because it has no uses: a rule that works leaves no use count. Demote one only when the user names it.
- For each note you propose to demote, write "or trash" in the why column. The user then picks demote or trash for the row in the same answer.
- If `demoted` has ids, list them below the table. The user can take one back, or trash it.
- When the user says delete, remove or get rid of, use `delete`. When the user says no longer needed, use `trash`. If you cannot tell, ask.
- For a rewrite, a merge or a shorten, write the new text now, so the user sees it before they accept.

## 3. Propose, then wait

Show one table, and below it the new text of every rewritten, merged or shortened note:

```
| # | note | reason | action | why |
|---|------|--------|--------|-----|
| 1 | <id> | anchor-changed | rewrite | <one line> |
```

Then ask the user which rows to apply: all, none, or a list of row numbers. For a demote row, the user can answer "trash" instead, for example "all, but trash 8 and 9". Stop and wait for the answer. Apply nothing before it.

## 4. Apply the accepted rows

- verify: `kb verify <id>...`
- rewrite, shorten: `kb add --json` with `"id"` and the fields that change. This also records the note as verified.
- merge: update the note that stays, with `"supersedes": ["<other id>", ...]`, then `kb trash <other id>...`
- trash: `kb trash <id>...`
- delete: `kb delete <id>...`
- demote: `kb add --json` with `{"id": "<id>", "indexed": false}`. To take a demotion back: `{"id": "<id>", "indexed": true}`

Use a quoted heredoc for JSON, so the shell changes nothing:

```bash
kb add --json <<'KB_NOTE'
{ "id": "<id>", "body": "<new body>" }
KB_NOTE
```

Never save a secret, token, password, key or credential in a note.

## 5. Report

Run `kb budget` again, then end with this and nothing after it:

```
verified: <ids>
rewritten: <ids>
merged: <kept id> <- <trashed ids>
trashed: <ids>
deleted: <ids>
demoted: <ids>
declined: <row numbers>
budget: <chars> of <budget> characters, <bodies> bodies, <lines> notes in the index only, <hidden> in no session
```

The budget line takes `context.chars`, `context.budget`, `context.bodies`, `index.lines` and `index.hidden` from `kb budget --json`.

Leave out an empty group.
