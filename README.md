# kb

A personal, repo-agnostic knowledge store for coding agents. It lets you `/clear` at any time
without losing durable knowledge: gotchas, decisions, conventions, procedures and unfinished work.

## The model

- **Notes** are plain markdown with YAML frontmatter in `~/.kb` (override with `KB_HOME`).
  One idea per note. Read, edit and grep them freely.
- **Scope** is `global` or a repo id. The repo id is the normalised origin remote
  (`github.com/owner/name`), so SSH clones, HTTPS clones and worktrees share one scope.
  A repo with no remote uses its directory name.
- **At session start** a hook injects `kb context` for `global` and the current repo: full
  bodies for the top-ranked notes, one index line for each note whose body did not fit, and a
  pointer to `kb show` and `kb search`. An index line is the id of the note, which is its title
  in short form, and after `...` the words of the title that the id cut. So a title that states
  the rule in full reaches every session, also when the body does not. It runs at startup,
  resume, `/clear`, compaction and fork.
- **Context stays small.** Two budgets in `kb.config.json`: `indexLines` (60) and
  `contextChars` (8000, clamped under the 10,000 character hook cap). Rank is open-work, gotcha,
  convention, decision, how-to, then repo before global, then last used, then last verified.
  Whole bodies drop from the bottom, and only a note without a body takes an index line.
  The store can grow for years and a session loads the same amount.
- **Before `/clear`** you run `/kb:checkpoint`. The agent saves what the session learned,
  updates notes instead of duplicating them, archives finished open work, and records which
  notes helped with `kb use`.
- **Nothing is deleted.** `kb archive` moves a note to `archive/`. If the store is a git repo,
  every write is one commit.
- **Notes go stale, and the store says so.** `kb stale` gives candidates with a reason: an
  anchored file changed since the note was verified, an anchor is gone, the verified commit left
  the history, nobody verified the note for `decayDays` (180), or two titles are close.
  `/kb:audit` reads the code for each candidate, checks both budgets, proposes verify, rewrite,
  merge, shorten, demote or archive, and applies what you accept. `kb budget` asks for a
  demotion only when the index is full and a note reaches no session. A body that became an
  index line is the normal state. It also lists the demoted notes, which no session loads. A session start says so in one
  line when more than 5 notes are candidates.
- **Proven notes move to the repo.** `/kb:promote` proposes notes with high confidence and many
  uses for the repo's `CLAUDE.md` or `AGENTS.md`, shows the exact text, and writes after you
  confirm. This is the only write `kb` makes inside a repo. A promoted note is no longer injected.
- **A missed checkpoint leaves a trace.** Nothing can run before `/clear`. So a session that ends
  with `/clear` and no checkpoint is recorded, and the next session in that directory gets one
  line with the path of its transcript, also when one of the two was in a subdirectory of the checkout. Before a compaction, a hook tells the summary what to
  keep, and the next start says once that no checkpoint ran.
- **Sync.** If the store has a git remote, each write starts a background pull and push, and
  each session start does the same at most once per 5 minutes. Usage counters live in one file
  per machine, so two machines never edit the same file.

```
~/.kb/
  notes/<scope>/<id>.md     archive/<scope>/<id>.md
  usage/<machine>.json      kb.config.json
  INDEX.md  local.json  .state/                 # generated or per-machine, not committed
```

## Commands

```
kb context [--repo .]        what a session gets at start
kb add [--repo .]            create or update a note from JSON on stdin
kb show <id>                 kb search <words> [--scope s] [--archive]
kb list [--scope s]          kb use <id>...
kb archive <id>...           kb restore <id>...
kb stale [--repo .]          kb verify <id>...
kb budget [--repo .]         kb promote <id> --to CLAUDE.md|AGENTS.md [--dry-run]
kb scope [--repo .]          kb serve     (local page: read, edit and archive notes)
kb sync                      kb checkpointed <session-id>
```

`kb serve`, or `kb` alone in a terminal, opens the store as a page at `http://127.0.0.1:4810/`: a sidebar of scopes and kinds, a
list, and the open note. The arrow keys move through the sidebar and the list. `e` edits the open
note and `a` archives it. `1` to `5` turn kinds on and off, and several can be on at once. `?` lists every key. On a phone the scopes and the kinds are two rows that scroll sideways, and a tap on a note brings it to the top of the screen. Each change goes through the same code as the CLI, so it is validated, committed and
synced. The server listens on this machine only, and stops with Ctrl+C. To reach it through a
reverse proxy, name the proxy's host in `KB_SERVE_HOSTS`, split by commas. A name that starts with a
dot, such as `.example.com`, takes that domain and every name under it, so one setting covers a
proxy that gives each port its own name. Everybody who can open that name can change notes.

The page is a React app in `web/` (Vite, Tailwind and shadcn/ui on Base UI). Its build in `web/dist` is
committed. After a change to `web/` or `cli/wire.ts`, run `bun install` and `bun run build` in `web/`, and
commit `web/dist` with the change. A test fails while the build is older than its sources.
`bun run dev` in `web/` serves the page with hot reload against a `kb serve` on port 4810.

`kb search` finds the notes that have every word of the query, in any order, in the title or the
body. When no note has every word, it prints the closest notes and says so. Each note is one line
with its scope, then the body lines that matched. The notes of the current repo come first, then
global, then other repos. `kb show` accepts a part of an id when only one note has it.

`--scope` takes `repo` (the repo of the current directory), `global` or a repo id. A scope that
has no notes is an error in `kb add`, `kb search` and `kb list`, so a typing error cannot put a
note where no session loads it. The first note of a repo is written from inside that repo, or with `--repo`.

Skills: `/kb:checkpoint`, `/kb:audit`, `/kb:promote`. Only you can start them.

Every command accepts `--json`. The CLI knows nothing about Claude Code: only `hooks/` and `skills/` do.

## Install

Requirements: a recent [Bun](https://bun.sh) (tested with 1.4) and git. There is no install step and no dependency to install:
the page of `kb serve` comes built in `web/dist`.

This repository is the plugin only. A marketplace lists it with a `github` source:

```json
{ "name": "kb", "source": { "source": "github", "repo": "<owner>/kb" } }
```

Then install it from that marketplace:

```bash
/plugin install kb --marketplace <owner>/<marketplace-repo>
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

To try a change on a store that looks like months of use (about 150 invented notes, 9 repos):

```bash
dir=$(mktemp -d) && bun scripts/seed.ts "$dir/seed"   # prints the KB_HOME to export
```
