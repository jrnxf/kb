# kb

A personal, repo-agnostic knowledge store for coding agents. It lets you `/clear` at any time
without losing durable knowledge: gotchas, decisions, conventions, procedures and unfinished work.

kb splits knowledge by source. A rule you state ("always", "never", a correction) goes to an
instruction file, such as `~/.claude/CLAUDE.md`, which every session loads whole. What the agent
learns (a gotcha, a decision, a how-to, open work) goes to kb, which loads the notes that rank
highest.

## The model

- **Notes** are plain markdown with YAML frontmatter in `~/.kb` (override with `KB_HOME`).
  One idea per note. Read, edit and grep them freely.
- **Scope** is `global` or a repo id. The repo id is the normalised origin remote
  (`github.com/owner/name`), so SSH clones, HTTPS clones and worktrees share one scope.
  A repo with no remote uses its directory name.
- **At session start** a hook injects `kb context` for `global` and the current repo: full
  bodies for the top-ranked notes, one index line for each note whose body did not fit, and a
  pointer to `kb show` and `kb search`. It also says how to write: a rule, a preference or a
  correction the user states goes to an instruction file in that turn, what the agent learns goes
  to `kb add`, and nothing goes to Claude Code's auto memory. An index line is the id of the note, which is its title
  in short form, and after `...` the words of the title that the id cut. So a title that states
  the rule in full reaches every session, also when the body does not. It runs at startup,
  resume, `/clear`, compaction and fork.
- **Notes load by path.** When the agent reads a file, a hook names the repo notes whose anchors
  name that file or a folder above it: the id, the kind and the title, at most five at a time. So
  a note reaches the agent when it works on the file, also when the note has no place in the
  index. Each note comes once per session, and again after a compaction. A file the agent gets
  with `@` is not a Read, so it names no notes.
- **Context stays small.** Budgets in `kb.config.json`: `indexLines` (60), `globalIndexLines`
  (20) and `contextChars` (8000, clamped under the 10,000 character hook cap, with the save rule
  on top). The repo's own notes rank first, by kind (open-work, gotcha, convention, decision,
  how-to), then last used, then last verified. Global notes come after them, open work first, then
  the most used. In a repo, global notes take at most `globalIndexLines` places, so they never
  crowd out the repo's notes. Whole bodies drop from the bottom, and only a note without a body
  takes an index line. The store can grow for years and a session loads the same amount.
- **A use is a read that helped.** `kb show` counts a use, because an agent reads a note when it
  needs it. `kb use` counts the injected notes that changed what the agent did. A check (an
  audit, a search before a write) passes `--no-use`. The use count ranks global notes.
- **A rule goes to an instruction file when the user states it.** The agent starts `/kb:note` on
  its own when the user says "always", "never", "from now on" or corrects it. `kb instructions`
  names the files. A global rule goes into the global file, which `globalInstructions` in
  `kb.config.json` names (`~/.claude/CLAUDE.md`). kb writes the file at the end of its links, so
  a dotfiles repo that links it gets the change. A repo rule goes into the repo's `CLAUDE.md` or
  `AGENTS.md` after you say yes. Nothing is committed for you.
- **Before `/clear`** you run `/kb:checkpoint`. The agent saves what the session learned,
  updates notes instead of duplicating them, writes stated rules to instruction files, trashes
  finished open work, empties Claude Code's auto memory, and records which notes helped with `kb use`.
- **A trash that clears itself.** `kb trash` moves a note to `trash/`, and `kb restore` brings it
  back. A note in the trash for more than `trashDays` (30) is deleted for good, before the next
  command. `kb delete` removes a note now, and `kb empty-trash` removes the whole trash. If the
  store is a git repo, every write is one commit.
- **A project goes whole.** `kb trash --scope <repo id>` moves every note of one repo to the
  trash in one commit, and `kb restore --scope` brings back that move and no older trash.
  `kb delete --scope` removes the project's notes for good, and `kb empty-trash --scope` only its
  trash. Each takes the exact repo id, and none touches `global`.
- **Notes go stale, and the store says so.** `kb stale` gives candidates with a reason: an
  anchored file changed since the note was verified, an anchor is gone, the verified commit left
  the history, no session used the note and nobody checked it for `expireDays` (90), nobody
  verified it for `decayDays` (180), or two titles are close. An expired note goes to the audit
  as trash, and you decide: kb never deletes a note on its own. A session start also checks the
  anchors of the repo's notes on disk, and tells the agent which notes name a file or a symbol that
  is gone.
  `kb stale` and `/kb:audit` cover one scope: the repo's notes in a repo, the global notes outside
  any repo. `/kb:audit` reads the code for each candidate, checks both budgets, and proposes keep, rewrite,
  merge, shorten or trash with `kb audit propose`. Each audit also moves rules to the
  instruction file of its scope: the agent merges the conventions into a few short rules, and each card
  shows the lines that Apply adds to the file. Apply writes them and does not commit the file. You decide in the `kb serve` page, one
  card per note: each card shows the note, the new text struck against the old, and the agent's
  pick with its reason. `a` accepts the agent's pick, `k` keeps the note as is and records that
  you checked it, `t` trashes it, a meter counts the notes that still reach no session, and Apply makes
  every pick in one commit. A note you send back for a rewrite waits for the agent in `kb audit status`. Outside a session, `kb audit` starts one headless agent (`claude -p`) that does the same audit, and prints the page link when its cards are ready. In a repo it audits that repo. Outside any repo it audits the global notes, in an empty folder that no repo reaches. The Audit button in the page does the same for the global notes, and for any repo a session has opened once. `kb budget` asks for
  room only when the index is full and a note reaches no session. A body that became an
  index line is the normal state. It names decisions and how-tos to trash or merge, and
  leaves gotchas and conventions for you to name, because a rule that works leaves no use count.
  A session start says so in one
  line when more than 5 notes are candidates.
- **Rules move to an instruction file.** A rule you stated belongs where every session loads it
  whole. The audit card offers to move it: a repo audit moves a repo rule to the repo's `CLAUDE.md`
  (or `.claude/CLAUDE.md`, then `AGENTS.md`, when the repo keeps its rules there, and it creates
  `CLAUDE.md` when the repo has none), and the global audit moves a global rule to the global file. The card shows the lines it
  adds. Apply writes the file and does not commit it. This is the only write `kb` makes inside a
  repo. A moved note is no longer injected.
- **A missed checkpoint leaves a trace.** Nothing can run before `/clear`. So a session that ends
  with `/clear` and no checkpoint is recorded, and the next session in that directory gets one
  line with the path of its transcript, also when one of the two was in a subdirectory of the checkout. Before a compaction, a hook tells the summary what to
  keep, and the next start says once that no checkpoint ran.
- **Sync.** If the store has a git remote, each write starts a background pull and push, and
  each session start does the same at most once per 5 minutes. Usage counters live in one file
  per machine, so two machines never edit the same file.

```
~/.kb/
  notes/<scope>/<id>.md     trash/<scope>/<id>.md
  usage/<machine>.json      kb.config.json
  INDEX.md  local.json  .state/                 # generated or per-machine, not committed
```

## Commands

```
kb context [--repo .]        what a session gets at start
kb add [--repo .]            create or update a note from JSON on stdin
kb show <id> [--no-use]      kb search <words> [--scope s] [--trash]
kb list [--scope s] [--trash]  kb use <id>...
kb trash <id>...             kb restore <id>...
kb delete <id>...            kb empty-trash
kb trash|restore|delete|empty-trash --scope <repo id>   a whole project
kb stale [--repo .]          kb verify <id>...
kb budget [--repo .]
kb scope [--repo .]          kb serve     (local page: read, edit and trash notes)
kb audit [--no-wait]         kb audit propose   kb audit status   (an agent audits the scope)
kb instructions [--repo .]   kb sync      kb checkpointed <session-id>
```

`kb serve`, or `kb` alone in a terminal, opens the store as a page at `http://127.0.0.1:4810/`: a sidebar of scopes and kinds, a
list, and the open note. The arrow keys move through the sidebar and the list. `e` edits the open
note and `⌫` moves it to the trash. In the trash, `⌫` deletes a note for good after a question,
and Empty trash clears it all, or with a scope picked only that scope's trash. With a project picked, Trash project (or `⌫` on the project in the sidebar) moves all its notes to the trash after a question, and Undo brings them back. `1` to `5` turn kinds on and off, and several can be on at once. `?` lists every key. On a phone the scopes and the kinds are two rows that scroll sideways, and a tap on a note brings it to the top of the screen. Each change goes through the same code as the CLI, so it is validated, committed and
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

kb syncs every note to git, so it refuses new text that holds a secret: `kb add`, an edit on the page,
and the text or rule of an audit Apply. It knows the shape of common tokens and keys (GitHub, AWS,
Anthropic, Slack and more), a password in a URL, and a long random value given to a name such as
`API_KEY`. The error names the kind and the place, never the secret. Write a placeholder instead.

Skills: `/kb:checkpoint`, `/kb:audit`. Only you can start them. `/kb:note` writes a rule the
user states to an instruction file, and the agent starts it on its own.

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

Turn off Claude Code's auto memory. It is a second store with the same job, and its system prompt
tells the agent to save preferences there. In `~/.claude/settings.json`:

```json
{ "autoMemoryEnabled": false }
```

While it is on, the first start of each session asks the agent to tell you. `/kb:checkpoint` empties it: rules go to instruction files, and facts go to kb.

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
bun install && bunx playwright install chromium-headless-shell
bun test && bun run typecheck && claude plugin validate .
```

`test/keys.test.ts` presses the page's keys in a headless Chromium, at desktop and phone width.
The `playwright install` step downloads that browser once.

To try a change on a store that looks like months of use (about 150 invented notes, 9 repos):

```bash
dir=$(mktemp -d) && bun scripts/seed.ts "$dir/seed"   # prints the KB_HOME to export
```
