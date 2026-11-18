---
name: audit
description: Check the kb notes of this repo for stale, duplicate and over-budget entries, propose changes, and hand them to the user in the kb serve page. Run only when the user types /kb:audit.
disable-model-invocation: true
allowed-tools: Bash(kb *)
model: opus
effort: medium
---

# kb audit

Keep the store true and small. You propose changes. The user picks in the page, and the page applies them.
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
  - `over` is true only when notes reach no session, because the index is full (`index.hidden`). Then `demote` lists decisions and how-tos to take out, least used first. Treat each one as a candidate too.
  - `ask` fills the rest of the hidden count with gotchas and conventions, least used first. Only the user can demote or trash one of them.
  - `demoted` lists the notes that an earlier audit took out of every session.

A candidate is a reason to look, not a verdict. If `kb stale` has no candidate and `over` is false, say so and stop.

## 2. Judge each candidate

Read the note with `kb show <id>`. For an anchor reason, read the anchored code as it is now. Then choose one action:

| Action | When |
|---|---|
| verify | The note is still true as written. |
| rewrite | The fact drifted. The note needs a new body, title or anchors. |
| trash | The fact is obsolete, the work is done, or the user no longer needs the note. `kb restore` brings it back. The trash deletes it after 30 days. |
| merge | Two or more notes cover one idea. One note keeps everything, the others go to the trash. |
| shorten | The note is true but long. Cut it to the fact, the reason and how to apply it. |
| demote | The note is true but rarely used, and `over` is true. No session loads it again. It stays searchable. |
| keep | Nothing to do. Use this for a `duplicate` candidate that is in fact a different idea. |

Rules:

- Do not verify a note you did not check against the code or a source. For a `global` note with no anchor, verify only when you know the fact still holds. If you cannot tell, propose `keep` and say what is unknown.
- Demote only when `over` is true, and at most as many notes as `demote` lists. Prefer merge, trash and shorten before demote. Never demote `open-work`.
- A demoted note leaves every session without a trace there. So never demote a `gotcha` or a `convention` because it has no uses: a rule that works leaves no use count. Demote one only when the user names it.
- For each note you propose to demote, write "or trash" in the why. The user picks demote or trash on the card.
- For a rewrite, a merge or a shorten, write the new text now, so the user sees it on the card.

## 3. Propose in the page, then stop

The user decides in the `kb serve` page, one card per note. Write the proposal as JSON, one item per candidate:

```bash
kb audit propose <<'KB_AUDIT'
{ "items": [
  { "id": "<id>", "action": "verify", "why": "<one line>", "reason": "anchor-changed" },
  { "id": "<id>", "action": "rewrite", "why": "<one line>", "body": "<new body>" },
  { "id": "<id>", "action": "merge", "why": "<one line>", "merge": ["<other id>"], "body": "<merged body>" },
  { "id": "<id>", "action": "demote", "why": "Rarely used. Or trash it.", "reason": "0 uses" },
  { "id": "<id>", "action": "keep", "why": "A rule. Only you can demote or trash it.", "group": "conventions that reach no session" }
] }
KB_AUDIT
```

- `action` is one of verify, rewrite, trash, merge, demote and keep. A shorten is a rewrite.
- A rewrite needs the new `title` or `body`, or both. A merge needs `merge`, the notes that go to the trash. The note `id` keeps every fact, so give it the merged text.
- `reason` is what `kb stale` or `kb budget` said. `why` is one line from you.
- Put the `ask` ids and the `demoted` ids in the items too, as `keep`, with a `group`. Cards with the same group sit together after a divider, and the user can keep the whole group with one key.
- What each card offers:
  - Every card but a merge offers trash.
  - A note in the index offers demote while notes reach no session. Open work never does.
  - A demoted note offers to put it back in the index.
  - A merge card offers merge, edit and keep both.
- Never propose delete. When the user asks for a note to be gone now, run `kb delete <id>` yourself, outside the audit.

`kb audit propose` prints the page link. If it says kb serve is not running, start `kb serve` in the background. Give the user the link, and stop. Apply nothing yourself: the page applies the picks in one commit.

## 4. After the user applies

When the user says it is applied, run `kb audit`. It lists what the page did, and the notes the user sent back with what is wrong with each.

For each note sent back, read it and the code again, and rewrite it with `kb add --json`:

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
demoted: <ids>
kept: <count>
budget: <chars> of <budget> characters, <bodies> bodies, <lines> notes in the index only, <hidden> in no session
```

The rewritten line includes the notes you rewrote in step 4. The budget line takes `context.chars`, `context.budget`, `context.bodies`, `index.lines` and `index.hidden` from `kb budget --json`.

Leave out an empty group.
