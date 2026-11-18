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
  - Bodies that did not fit (`context.dropped`) are normal: each of these notes still reaches the session as an index line. This alone is no reason to take a note out. The notes with the most `chars` are the bodies to shorten, so that more notes load whole.
  - `over` is true only when notes reach no session, because the index is full (`index.hidden`). Then `trim` lists decisions and how-tos to look at first, least used first. Treat each one as a candidate too.
  - `ask` fills the rest of the hidden count with gotchas and conventions, least used first. Only the user can trash one of them.

A candidate is a reason to look, not a verdict. If `kb stale` has no candidate and `over` is false, say so and stop.

## 2. Judge each candidate

Read the note with `kb show <id>`. For an anchor reason, read the anchored code as it is now. Then choose one action:

| Action | When |
|---|---|
| rewrite | The fact drifted. The note needs a new body, title or anchors. |
| trash | The fact is obsolete, the work is done, or the user no longer needs the note. `kb restore` brings it back. The trash deletes it after 30 days. |
| merge | Two or more notes cover one idea. One note keeps everything, the others go to the trash. |
| shorten | The note is true but long. Cut it to the fact, the reason and how to apply it. |
| keep | The note is still true as written, or you cannot tell. Also a `duplicate` candidate that is in fact a different idea. |

Rules:

- Check a note against the code or a source before you say that it is still true. When you checked it, set `"checked": true` on the keep, and kb records the check. If you cannot tell, propose `keep` without `checked` and say what is unknown.
- When `over` is true, make room with merge and trash. Shortening a `trim` note frees nothing, because it ranks low. Propose trash for a `trim` note only when it is obsolete or adds nothing. Never trash `open-work` that is not done.
- Never propose trash for a `gotcha` or a `convention` because it has no uses: a rule that works leaves no use count. Propose `keep`, and the user decides.
- For a rewrite, a merge or a shorten, write the new text now, so the user sees it on the card.

## 3. Propose in the page, then stop

The user decides in the `kb serve` page, one card per note. Write the proposal as JSON, one item per candidate:

```bash
kb audit propose <<'KB_AUDIT'
{ "items": [
  { "id": "<id>", "action": "keep", "checked": true, "why": "I read cli/serve.ts. The port is still 4173.", "reason": "anchor-changed" },
  { "id": "<id>", "action": "rewrite", "why": "The flag is now --repo, not --dir.", "body": "<new body>" },
  { "id": "<id>", "action": "trash", "why": "PR #12 is merged. This work is done." },
  { "id": "<id>", "action": "merge", "why": "The two notes give the same rule: pin the bunx version.", "merge": ["<other id>"], "body": "<merged body>" },
  { "id": "<id>", "action": "trash", "why": "Sessions used this note one time, in August. The tool it describes is gone.", "reason": "1 use" },
  { "id": "<id>", "action": "keep", "why": "A use counts only when a checkpoint names the note. So 0 uses does not show that the rule is not useful.", "group": "Rules with few uses: only you can remove one to make room" },
  { "id": "<id>", "action": "keep", "why": "I could not check this note. It has no anchor, and the tap repo is not on this machine." }
] }
KB_AUDIT
```

- `action` is one of keep, rewrite, trash and merge. A shorten is a rewrite.
- A rewrite needs the new `title` or `body`, or both. A merge needs `merge`, the notes that go to the trash. The note `id` keeps every fact, so give it the merged text.
- `reason` is what `kb stale` or `kb budget` said.
- `checked` is only for a keep, and only when you read the code or a source and the note is still true.
- `why` is the evidence for your pick, in 140 characters or fewer. The user reads it on the card with no other context.
  - Say what you checked or found: the file, the commit, the PR, the date. "Still true" alone is not evidence.
  - Do not repeat the action name or the note title. The card shows both.
  - Write it in ASD-STE100 Simplified Technical English: sentences of 20 words or fewer, active voice, simple tenses, no phrasal verbs, no semicolons, and keep the articles.
  - Use full words. No shorthand like "A rule."
  - For a keep, say what you could not check or why no change is right.
- Put the `ask` ids in the items too, as `keep`, with a `group`. Cards with the same group sit together after a divider, and the user can keep the whole group with one key. A group keep records no check.
- What each card offers:
  - Every card offers to accept your pick, edit the text and keep as is. Every card but a merge offers trash and asking you for a rewrite.
  - When the user keeps a note on its card, kb records the check.
  - A card with your new text offers to use it.
  - A merge card offers merge and keep both.
- Never propose delete. When the user asks for a note to be gone now, run `kb delete <id>` yourself, outside the audit.

`kb audit propose` prints the page link. If it says kb serve is not running, start `kb serve` in the background. Give the user the link, and stop. Apply nothing yourself: the page applies the picks in one commit.

## 4. After the user applies

When the user says it is applied, run `kb audit status`. It lists what the page did, and the notes the user sent back with what is wrong with each.

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
checked and kept: <ids>
kept, not checked: <ids>
rewritten: <ids>
merged: <kept id> <- <trashed ids>
trashed: <ids>
budget: <chars> of <budget> characters, <bodies> bodies, <lines> notes in the index only, <hidden> in no session
```

The rewritten line includes the notes you rewrote in step 4. The budget line takes `context.chars`, `context.budget`, `context.bodies`, `index.lines` and `index.hidden` from `kb budget --json`.

Leave out an empty group.
