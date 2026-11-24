---
name: audit
description: Check the kb notes of this repo, or the global notes outside any repo, for stale, duplicate and over-budget entries, propose changes, and hand them to the user in the kb serve page. Run only when the user types /kb:audit.
disable-model-invocation: true
allowed-tools: Bash(kb *)
model: opus
effort: medium
---

# kb audit

Keep the store true and small. You propose changes. The user picks in the page, and the page applies them.
`kb` is on PATH. Run every `kb` command from the session's project directory, so scope and commit resolve.
In a repo, the audit covers that repo's notes. Outside any repo, it is the global audit: it covers the global notes. Both can move rules to an instruction file (step 2): a repo audit to the repo's file, the global audit to the global file.

## 1. Collect

```bash
kb stale --json
kb budget --json
```

- `kb stale` lists candidates for this scope: the repo's notes in a repo, the global notes outside any repo. Each has a `reason`:
  - `anchor-changed` - the code of an anchor changed since the note was verified.
    - An anchor on a whole file gives this reason at every change of that file. When the fact is about one function, class, constant or config key, name `path#symbol` as the new anchor in `why`, as for `not-needed` below. Then only a change to the lines of that symbol counts.
  - `anchor-missing` - an anchored path is gone, or the symbol is no longer in the file.
  - `commit-unknown` - the clone does not have the verified commit (a shallow clone, or a branch that was never fetched or is deleted). Only a note with an anchor that has no hash gets it.
  - `judged-wrong` - a session gave the note the verdict `wrong` after its last check. Read the note and the code. Then propose a rewrite, or trash when the fact is gone. When a session corrected the note already and it is true now, propose keep with `checked`.
  - `expired` - the note had no activity on any machine and nobody checked it for `expireDays` (90). Activity is a `kb show` for a task, a trigger that loaded the note, or a verdict `helped`. Propose trash, also for a gotcha or a convention, but not for open work that is not done. If the note still holds, the user picks keep on the card, and the keep records a check that resets the clock.
  - `decayed` - the note has not expired, but nobody verified it within the decay window.
  - `not-needed` - in at least 3 sessions a trigger loaded the note (a command, an error or a file), and the session judged it `not-needed` after its last check. None judged it `helped`. The note loads where it has no bearing.
    - Read the note's `triggers` and `anchors` with `kb show <id> --check`. Propose a narrower trigger: more words in a `cmd:` (`cmd: git push --force`, not `cmd: git push`), a longer `err:` text, or an anchor on the file and not on its folder.
    - A card cannot change triggers or anchors. So propose keep, and name the new triggers or anchors in `why`. The user sends the note back, and you set them in step 4.
    - When the title is too wide, propose a rewrite with a narrower title, so a session knows from the index line when the note applies.
    - If the note loads in the right place, propose keep.
  - `duplicate` - the note is close to another note of this scope in its words, by the measure that `kb add` uses. The detail names the other note and the words both have. Read both. Propose a merge when they say one fact, and keep when they say two. A pair never has a note of another scope, so a merge always stays in the scope of the audit.
- `kb budget` shows what a session start of this scope gives. No note loads its body there. `notes` lists each note in rank order, with what a session gets of it (`shown`):
  - `brief` - open work of this scope in short form: the title, the `Next:` line and a pointer. At most 3 notes, the newest verified first.
  - `index` - one line with the id and the title.
  - `trigger` - a global note with a `cmd:`, `stop:` or `err:` trigger. It takes no line on purpose, and loads at its trigger. That is not a reason to change it. Open work always keeps its line.
  - `hidden` - the index line did not fit the character budget, so no session sees the note.
- `over` is true only when notes are `hidden`. Repo notes rank first, so global notes are the first to go. `index.hiddenRepo` counts the hidden notes of the repo, and `index.hiddenGlobal` counts the hidden global notes.
  - `globalAudit` is true when only the global audit makes room. This happens in a repo: no repo note is hidden, and the global notes do not fit outside a repo either. Then `trim` and `ask` are empty. Propose no trash and no merge of a repo note to make room: this audit covers repo notes only. Tell the user to run /kb:audit outside any repo.
  - In every other case `makeRoomFor` lists the hidden notes that this audit can give a line. In a repo with no hidden note of its own, they are global notes: they fit outside a repo, and the notes of this repo take their room.
  - `trim` lists the lowest ranked decisions and how-tos of this scope, the lowest first. Treat each one as a candidate too. The limit is characters, so the list ends when its lines make room. It can be longer or shorter than `makeRoomFor`.
  - `ask` fills the rest of the room with gotchas and conventions, the lowest ranked first. Only the user can trash one of them.
- Open work with no `Next:` line gets a brief of its first 240 characters. Propose a rewrite that adds the line. In a repo audit, open work with the scope `global` is one index line: say in `why` which repo it belongs to.

A candidate is a reason to look, not a verdict. If `kb stale` has no candidate and `over` is false, say so and stop. If `kb stale` has no candidate and `globalAudit` is true, say that the global audit makes room, and stop.

## 2. Judge each candidate

Read the note with `kb show <id> --check`, so the log records a check and not a need for the note. For an anchor reason, read the anchored code as it is now. Then choose one action:

| Action | When |
|---|---|
| rewrite | The fact drifted. The note needs a new body, title or anchors. |
| trash | The fact is obsolete, the work is done, or the user no longer needs the note. `kb restore` brings it back. The trash deletes it after 30 days. |
| merge | Two or more notes cover one idea. One note keeps everything, with the triggers of all of them. The others go to the trash. |
| shorten | The note is true but long. Cut it to the fact, the reason and how to apply it. |
| keep | The note is still true as written, or you cannot tell. Also a `duplicate` candidate that is in fact a different idea. |
| promote | The note is a rule for how to work, which the user stated. It moves to the instruction file of the audit's scope, which every session loads whole. |

Rules:

- Check a note against the code or a source before you say that it is still true. When you checked it, set `"checked": true` on the keep, and kb records the check. If you cannot tell, propose `keep` without `checked` and say what is unknown.
- When `over` is true and `globalAudit` is false, make room with merge and trash. A shorter body frees nothing: only the index line of a note takes room. A shorter title frees a few characters. Propose trash for a `trim` note only when it is obsolete or adds nothing. Never trash `open-work` that is not done.
- Never propose trash for a `gotcha` or a `convention` only because it ranks low or no session opened it: a rule that works leaves no trace in the log. Propose `keep`, and the user decides. The one exception is an `expired` note: then nobody checked it either, so propose trash. A `not-needed` reason alone is no reason to trash a rule.
- For a rewrite, a merge or a shorten, write the new text now, so the user sees it on the card.

### Move rules to the instruction file

A rule the user states belongs in an instruction file, not in kb. Every `convention` of the scope is a candidate, also without a `kb stale` reason. Find them with `kb list --json` in a repo, or `kb list --scope global --json` outside any repo.

The file depends on the scope:
- A repo audit writes the first of the repo's `CLAUDE.md`, `.claude/CLAUDE.md` and `AGENTS.md` that exists. When the repo has none, Apply creates `CLAUDE.md`. Move a rule there only when it holds for anyone who works in the repo.
- The global audit writes the global instructions file.

1. Run `kb instructions` and read the whole file of the scope. It loads into every session, and it is often long already.
2. Group the conventions that say one thing. Each group becomes one `promote` item: the first note is `id`, and the others go in `merge`. They all move with the rule.
3. Write the `rule` for each group: as few lines as the rule needs, often one, in the style of the file around it. Merge, do not copy: a short instruction, with no history and no dates.
4. Pick a `section`: a heading that the file has, or a new heading when none fits.
5. When the file already says the rule, propose `trash` for the notes, and name the line in `why`.

A gotcha, a how-to or open work is a fact the agent learned. It stays in kb.
Never write the instructions file yourself. Apply writes it, at the end of the section, and does not commit it.

## 3. Propose in the page, then stop

The user decides in the `kb serve` page, one card per note. Write the proposal as JSON to a file in your scratchpad directory with the Write tool, one item per candidate. A write there needs no permission:

```json
{ "items": [
  { "id": "<id>", "action": "keep", "checked": true, "why": "I read cli/serve.ts. The port is still 4173.", "reason": "anchor-changed" },
  { "id": "<id>", "action": "rewrite", "why": "The flag is now --repo, not --dir.", "body": "<new body>" },
  { "id": "<id>", "action": "trash", "why": "PR #12 is merged. This work is done." },
  { "id": "<id>", "action": "merge", "why": "The two notes give the same rule: pin the bunx version.", "merge": ["<other id>"], "body": "<merged body>" },
  { "id": "<id>", "action": "trash", "why": "PR #31 removed the tool that this note describes.", "reason": "low rank, 58 of 61" },
  { "id": "<id>", "action": "keep", "why": "The index is full and this rule ranks low. A rule that works leaves no trace, so I cannot tell if you need it.", "group": "Rules that rank low: only you can remove one to make room" },
  { "id": "<id>", "action": "keep", "why": "I could not check this note. It has no anchor, and the tap repo is not on this machine." },
  { "id": "<id>", "action": "promote", "why": "The user stated this rule. The two other notes say the same thing.", "rule": "- Write short sentences in the active voice.", "section": "Style", "merge": ["<id>", "<id>"] }
] }
```

Then run this. Write the whole path of the file in the command itself:

```bash
kb audit propose --file /full/path/of/the/file.json
```

A session with normal permissions refuses a command that sets a shell variable for the path. It also refuses a heredoc that holds the JSON.

- `action` is one of keep, rewrite, trash, merge and promote. A shorten is a rewrite.
- A rewrite needs the new `title` or `body`, or both. A merge needs `merge`, the notes that go to the trash. The note `id` keeps every fact, so give it the merged text.
- A promote needs the `rule`, the lines to add to the instructions file. `section` is the heading they go under. `merge` is optional: the other notes that move with the rule.
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
  - Every card offers to accept your pick, edit the text, keep and trash. On a card with several notes, trash takes every note on it. Every card but a merge offers asking you for a rewrite.
  - When the user keeps a note on its card, kb records the check.
  - A card with your new text offers to use it.
  - A merge card offers merge, keep both and trash both (or trash all N).
  - A promote card shows the lines it adds, under the lines above them in the file. It offers move, keep, edit, ask and trash.
- Never propose delete. When the user asks for a note to be gone now, run `kb delete <id>` yourself, outside the audit.

`kb audit propose` prints the page link. If it says kb serve is not running, start `kb serve` in the background. Give the user the link, and stop. Apply nothing yourself: the page applies the picks in one commit.

## 4. After the user applies

When the user says it is applied, run `kb audit status`. It lists what the page did, and the notes the user sent back with what is wrong with each.

For each note sent back, read it and the code again, and rewrite it. Write this JSON to a new file with the Write tool, as in step 3. Add `"triggers"` or `"anchors"` when the request is for a narrower trigger or anchor. A list replaces the old list:

```json
{ "id": "<id>", "body": "<new body>" }
```

```bash
kb add --json --file /full/path/of/the/file.json
```

An update by `id` answers `updated` or an error. It never answers `neighbors`, the answer for which `kb add` exits with code 2.

Never save a secret, token, password, key or credential in a note.

## 5. Report

Run `kb budget` again, then end with this and nothing after it:

```
checked and kept: <ids>
kept, not checked: <ids>
rewritten: <ids>
merged: <kept id> <- <trashed ids>
moved to <file>: <ids>
trashed: <ids>
budget: <chars> of <budget> characters, <briefs> briefs, <lines> index lines, <trigger> notes at a trigger only, <hidden repo> repo notes and <hidden global> global notes in no session
```

The rewritten line includes the notes you rewrote in step 4.
The budget line takes its numbers from `kb budget --json`, in this order: `context.chars`, `context.budget`, `briefs.count`, `index.lines`, `index.triggerOnly`, `index.hiddenRepo` and `index.hiddenGlobal`.
Outside any repo there are no repo notes: write `<hidden global> global notes in no session`.
When `globalAudit` is true, add one line: `the global notes do not fit: run /kb:audit outside any repo`.

Leave out an empty group.
