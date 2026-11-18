---
name: promote
description: Propose moving proven kb notes of this repo into its CLAUDE.md or AGENTS.md, show the exact text, and write only after the user confirms. Run only when the user types /kb:promote.
disable-model-invocation: true
allowed-tools: Bash(kb *)
---

# kb promote

A note that proved itself many times belongs in the repo's own instruction file, where every agent and every person gets it. `kb promote` is the only `kb` command that writes inside a repo. It runs only after the user confirms.
`kb` is on PATH. Run every `kb` command from the session's project directory.

## 1. Find candidates

```bash
kb list --scope "$(kb scope)" --json
```

A candidate has all of these:

- `confidence` is `high`
- `uses` is high for this store: as a guide, 3 or more, and among the most used notes of the repo
- `kind` is `convention`, `gotcha`, `decision` or `how-to`. Never promote `open-work`.
- `promoted_to` is null
- the fact concerns everybody who works in the repo, not only this user

Read each candidate with `kb show <id> --no-use`. Drop a note when the repo's instruction files already say the same thing. If no note qualifies, say so and stop.

## 2. Choose the file

Use the instruction file the repo already has. If it has both `CLAUDE.md` and `AGENTS.md`, use the one that holds the content: the other is often a link or an import. If it has neither, ask the user which one to create.

## 3. Show the exact text, then wait

For each candidate, get the text without writing anything:

```bash
kb promote <id> --to CLAUDE.md --dry-run
```

Show the user, per candidate: the id, the use count, the target file, and the exact text as a diff of added lines. If the note is still true but its wording fits a private note more than a shared file, update the note first with `kb add --json` and show the new dry run.

Then ask which candidates to write: all, none, or a list. Stop and wait for the answer. Write nothing before it.

## 4. Write the accepted ones

```bash
kb promote <id> --to CLAUDE.md
```

The command appends the text to the file and marks the note, so sessions stop loading it twice. It does not commit in the repo. Leave the commit to the user.

## 5. Report

```
promoted: <id> -> <file>
declined: <id>
```

Leave out an empty group. Remind the user in one line that the repo file has uncommitted changes.
