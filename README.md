# kb

A personal, repo-agnostic knowledge store for coding agents. It lets you `/clear` at any time
without losing durable knowledge: gotchas, decisions, conventions, procedures and unfinished work.

## The model

- **Notes** are plain markdown with YAML frontmatter in `~/.kb` (override with `KB_HOME`).
  One idea per note. Read, edit and grep them freely.
- **Scope** is `global` or a repo id. The repo id is the normalised origin remote
  (`github.com/owner/name`), so SSH clones, HTTPS clones and worktrees share one scope.
  A repo with no remote uses its directory name.
- **At session start** a hook injects `kb context`: one index line per note for `global` and
  the current repo, then full bodies for the top-ranked notes, then a pointer to `kb show` and
  `kb search`. It runs at startup, resume, `/clear`, compaction and fork.
- **Context stays small.** Two budgets in `kb.config.json`: `indexLines` (60) and
  `contextChars` (8000, clamped under the 10,000 character hook cap). Rank is open-work, gotcha,
  convention, decision, how-to, then repo before global, then last used, then last verified.
  Whole notes drop from the bottom. The store can grow for years and a session loads the same amount.
- **Before `/clear`** you run `/kb:checkpoint`. The agent saves what the session learned,
  updates notes instead of duplicating them, archives finished open work, and records which
  notes helped with `kb use`.
- **Nothing is deleted.** `kb archive` moves a note to `archive/`. If the store is a git repo,
  every write is one commit.
- **Sync.** If the store has a git remote, each write starts a background pull and push, and
  each session start does the same at most once per 5 minutes. Usage counters live in one file
  per machine, so two machines never edit the same file.

```
~/.kb/
  notes/<scope>/<id>.md     archive/<scope>/<id>.md
  usage/<machine>.json      kb.config.json
  INDEX.md  index.html  local.json     # generated or per-machine, not committed
```

## Commands

```
kb context [--repo .]        what a session gets at start
kb add [--repo .]            create or update a note from JSON on stdin
kb show <id>                 kb search <query> [--scope s] [--archive]
kb list [--scope s]          kb use <id>...
kb archive <id>...           kb restore <id>...
kb scope [--repo .]          kb html      (overview page, opens in the browser)
kb sync                      kb help
```

Every command accepts `--json`. The CLI knows nothing about Claude Code: only `hooks/` and `skills/` do.

## Install

Requirements: a recent [Bun](https://bun.sh) (tested with 1.4) and git. `ripgrep` is optional. There is no install step and no dependency.

```bash
/plugin install kb --marketplace <owner>/<repo>
```

With auto-update on for the marketplace, each machine follows the default branch. The plugin
sets no `version`, so every commit is a release.

To work on the plugin, load a checkout for one session:

```bash
claude --plugin-dir /path/to/kb
```

To back up and sync the store, make it a clone of a private repo before the first note:

```bash
git clone <your-private-repo-url> ~/.kb
```

## Develop

```bash
bun install && bun test && bun run typecheck && claude plugin validate .
```
