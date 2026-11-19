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
  correction the user states goes to an instruction file in that turn, and what the agent learns
  goes to `kb add`. While Claude Code's auto memory is on, it also says that nothing goes there.
  An index line is the id of the note, which is its title
  in short form, and after `...` the words of the title that the id cut. So a title that states
  the rule in full reaches every session, also when the body does not. It runs at startup,
  resume, `/clear`, compaction and fork. With auto memory off, the fixed text is three lines:
  the scope, one line on how to read the notes, and the save rule.
- **Notes load by path.** When the agent reads or changes a file, a hook gives the repo notes whose
  anchors name that file or a folder above it. A gotcha comes whole, because a title that the agent
  does not open is lost. Another kind comes as one line: the id, the kind and the title. A Read
  gives at most five notes, and a change at most three. A shell command that names the path counts
  too: `sed -n 1,40p src/pay.ts` loads the notes on `src/pay.ts`. So a note reaches the agent when
  it works on the file, also when the note has no place in the index. Each note comes once per
  session, and again after a compaction or a `/clear`. A subagent has its own context, so it gets
  the notes too. A file the agent gets with `@` is not a Read, so it loads no notes.
- **Notes load at their trigger.** A session start gives notes before the task is known, and most
  tool calls are shell commands. So a note can carry `triggers`, and a hook loads the note at the
  moment it applies:
  - `cmd: pkill -f` loads the note before a shell command that runs `pkill -f`. The command still runs.
  - `stop: git push --force` refuses the command once, with the note as the reason. The second run
    passes. It is for a command where one run does damage.
  - `err: address already in use` loads the note after a tool call that failed with that text in
    its error.

  The agent gets the id, the kind, the title and the body. A body over 600 characters is cut, with
  a pointer to `kb show`. At most three notes load for one tool call. Each note comes once per
  session and subagent, and again after a compaction or a `/clear`. A repo note loads in its repo,
  and a global note loads everywhere. A `cmd` or a `stop` trigger matches like this:
  - kb cuts the command line into simple commands at `;`, `&&`, `||`, `|`, `&`, a line break and `$( )`.
  - One simple command must hold the words of the trigger in order, as whole words. Other words
    may stand between them.
  - The first word must be the command word. So `cmd: pkill -f` matches `sudo pkill -9 -f x` and
    `a && pkill -f x`, and it does not match `echo "pkill -f"`.
  - After `sudo`, `env`, `xargs`, `timeout`, `ssh` and such, each later word can be the command
    word. The quoted script of `bash -c`, `ssh` or `eval` is read as a command line.
  - A quoted argument, a comment and the body of a heredoc are data. `-rf` and `-fr` are two words,
    so each form needs its own trigger.

  `kb add` refuses a trigger of one word that is a common command, such as `ls`, `git` or `bun`:
  it needs a second word. An `err` text needs 8 characters. Case and line breaks do not count in
  it. The hook runs before every shell command, so it reads no note file: it reads one small table
  of all triggers and anchors, which kb builds again when a note file changes. A command that
  matches nothing costs about 20 ms.
- **Context stays small.** Budgets in `kb.config.json`: `indexLines` (60), `globalIndexLines`
  (20) and `contextChars` (8000, clamped under the 10,000 character hook cap, with the save rule
  on top). The repo's own notes rank first, by kind (open-work, gotcha, convention, decision,
  how-to), then last activity on any machine, then last verified. Global notes come after them:
  open work first, then by last activity, then by kind, then last verified. So a global note that
  sessions open keeps its place. No count of reads is in the order. In a repo,
  global notes take at most `globalIndexLines` places, so they never crowd out the repo's notes. Whole bodies drop from the bottom, and only a note without a body
  takes an index line. The store can grow for years and a session loads the same amount.
- **A log says what each session got.** Each machine keeps an event log in `.state/log/`. It
  records the notes a session got at its start, and in what form: a body, an index line, or
  nothing. It also records the notes a trigger loaded, each `kb show` and `kb search`, each write and
  each checkpoint. A read writes nothing to the store, so it makes no commit and no sync. A check
  (an audit, a look before an update) passes `--check`. At the checkpoint the agent gives a
  verdict on the notes it got: `kb verdict helped`, `not-needed` or `wrong`. `not-needed` is only
  for a note that a trigger loaded in that session: kb refuses it for a note from the session start,
  which loads in every session. A note that the session corrected gets no `wrong`. `kb log` sums the
  log per note, for the next audit. The log never leaves the machine, and it keeps 12 months: a
  monthly file older than that is removed.
- **A roll-up of the log syncs.** Each machine writes one small file, `activity/<machine>.json`:
  per note, the last activity and the times of the newest verdicts. It writes the file at most
  once per day, and only when something changed. A read never writes it. The file goes into the
  next commit that the store makes: a write of a note, or a sync. Each machine writes only its own
  file, so two machines never conflict. So a note that one machine opens every week does not
  expire on another, and a fresh clone knows what is active. The last activity stays in the
  roll-up after its month left the log.
- **A rule goes to an instruction file when the user states it.** The agent starts `/kb:note` on
  its own when the user says "always", "never", "from now on" or corrects it. `kb instructions`
  names the files. A global rule goes into the global file, which `globalInstructions` in
  `kb.config.json` names (`~/.claude/CLAUDE.md`). kb writes the file at the end of its links, so
  a dotfiles repo that links it gets the change. A repo rule goes into the repo's `CLAUDE.md` or
  `AGENTS.md` after you say yes. Nothing is committed for you.
- **Before `/clear`** you run `/kb:checkpoint`. The agent saves what the session learned,
  updates notes instead of duplicating them, writes stated rules to instruction files, trashes
  finished open work, empties Claude Code's auto memory, and gives a verdict on the notes it got with `kb verdict`.
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
  the history, the note had no activity and nobody checked it for `expireDays` (90), nobody
  verified it for `decayDays` (180), or two titles are close. Activity is a `kb show` for a task,
  a trigger that loaded the note, or a verdict `helped`, on any machine. An expired note goes to the audit
  as trash, and you decide: kb never deletes a note on its own. Two reasons come from the verdicts
  of all machines. `judged-wrong`: a session gave the note the verdict `wrong` after its last
  check. `not-needed`: at least 3 sessions judged it `not-needed` after its last check, and none
  judged it `helped`. A new verification clears both: `kb verify`, or an update of the title, the
  body or the anchors. A session start also checks the
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
  index line is the normal state. It names the lowest ranked decisions and how-tos to trash or
  merge, and leaves gotchas and conventions for you to name, because a rule that works leaves no
  trace in the log.
  A session start says so in one
  line when more than 5 notes are candidates.
- **Rules move to an instruction file.** A rule you stated belongs where every session loads it
  whole. The audit card offers to move it: a repo audit moves a repo rule to the repo's `CLAUDE.md`
  (or `.claude/CLAUDE.md`, then `AGENTS.md`, when the repo keeps its rules there, and it creates
  `CLAUDE.md` when the repo has none), and the global audit moves a global rule to the global file. The card shows the lines it
  adds. Apply writes the file and does not commit it. This is the only write `kb` makes inside a
  repo. A moved note is no longer injected.
- **A missed checkpoint can be recovered.** Nothing can run before `/clear`, but `/clear` keeps the
  transcript on disk. So a session that ends with `/clear` and no checkpoint is recorded, and a
  new session in that checkout says in one line that `/kb:recover` saves it. The agent tells you
  once per day and checkout. Other starts in that day only let the agent know, so a script or a
  second window does not get the same sentence each time. `/kb:recover` hands
  what the user and the agent said to a Sonnet subagent, which runs the checkpoint steps. No tool
  call and no tool output gets through, also not the output of a `!` command. The reason you typed
  when you rejected a tool call, and your answer to a question, stay in.
  - The report starts with "Recovered" and the date and directory of the old session. It says
    nothing about the session you are in, which still needs its own `/kb:checkpoint`.
  - A recovered note is verified at the time the old session ended (`kb add --as-of`), with low
    confidence. So `kb stale` sees the changes made since then. A note that somebody checked after
    that time stays as it is: the report lists what the old session adds under "Check by hand".
  - The subagent writes no instruction file. It lists each rule it found, and you say which still
    hold. The session counts as saved only after that. Until then the line comes back. Each note
    of a recovery is recorded in the session (`kb add --recovered-from`), so a second
    `/kb:recover` adds no note twice.
  - The text of the old session is in `.state/recover/`, readable by you only. It goes when the
    session is saved or forgotten, and after 7 days.
  - `/kb:recover forget` stops the line. A session with fewer than 2 prompts or 3000 characters
    is not reported. A slash command counts only for the arguments you typed after it, and a
    `/kb:recover` turn does not count, so a session that only recovered another one is not
    reported. A record goes after 7 days.
  - A session start never reads a transcript over 2 MB: such a session is reported as it is. The
    whole step has 300 ms. A session it could not measure in that time waits for a later start.

  Nothing runs in the background. Before a compaction, a hook tells the summary what to keep, and
  the next start says once that no checkpoint ran.
- **Sync.** If the store has a git remote, each write starts a background pull and push, and
  each session start does the same at most once per 5 minutes. The event log stays on its
  machine, and its roll-up in `activity/` syncs. The `usage/` files of an older kb stay in the
  store as history: kb reads the last use in them, and writes them no more. `kb add` never gives a
  new note an id that has a history on any machine.

```
~/.kb/
  notes/<scope>/<id>.md     trash/<scope>/<id>.md
  kb.config.json            usage/<machine>.json    # counters of an older kb, read only
  activity/<machine>.json                       # the roll-up of each machine's log, synced
  INDEX.md  local.json  .state/                 # generated or per-machine, not committed
  .state/log/<YYYY-MM>.jsonl                    # the event log of this machine, 12 months
  .state/triggers.json                          # the table of triggers and anchors that the hooks read
```

## A note

```markdown
---
id: zorp-wipe-removes-the-cache-of-every-project
title: zorp --wipe removes the cache of every project
scope: github.com/example-org/atlas-api
kind: gotcha
created: 2026-01-10T09:00:00Z
last_verified: 2026-03-02T14:30:00Z
verified_at_commit: 3f2a91c
anchors:
  - scripts/cache.sh
triggers:
  - "cmd: zorp --wipe"
  - "err: cache index is missing"
confidence: high
---
Pass `--project <name>`. A wipe with no project takes ten minutes to rebuild.
```

- `id` is the title in short form. `scope` is `global` or a repo id.
- `kind` is `open-work`, `gotcha`, `convention`, `decision` or `how-to`. `confidence` is `high`, `medium` or `low`.
- `last_verified` and `verified_at_commit` say when somebody last checked the fact. A new title, body or anchor is a check. A new trigger is not.
- `anchors` are repo-relative paths, or `path#symbol`. They let `kb stale` find a note that the code left behind, and they load the note by path.
- `triggers` are optional: `cmd:`, `stop:` and `err:`, as "Notes load at their trigger" says. A path is an anchor, not a trigger.

kb also writes `promoted_to` (the instruction file a rule moved to), `supersedes` (the notes a merge
took in) and `trashed_at`. `kb add` answers with `warnings`, and still saves the note, when a gotcha
or a how-to has no trigger and no anchor, and when a body is over 700 characters.

## Hooks

- `SessionStart` (startup, resume, clear, compact, fork) prints `kb context`, the save rule and the notices.
- `PreToolUse` on Bash, Edit, Write and NotebookEdit loads the notes of a `cmd` or a `stop` trigger, and the notes on a path.
- `PostToolUseFailure` loads the notes of an `err` trigger. Claude Code sends the output of a failed call only there.
- `PostToolUse` on Read loads the notes on the file.
- `PreCompact` tells the summary what to keep, and `SessionEnd` on `/clear` records a session with no checkpoint.

No hook can break or slow a session: on any failure it prints nothing and exits 0. The two hooks for
tool calls have 2 and 3 seconds.

## Commands

```
kb context [--repo .]        what a session gets at start
kb add [--repo .]            create or update a note from JSON on stdin
kb add --as-of <ISO time>    the same for a fact from an earlier time: the note is verified then
kb add --recovered-from <session-id>   also record the note in that unsaved session
kb show <id> [--check]       kb search <words> [--scope s] [--trash] [--check]
kb list [--scope s] [--trash]  kb verdict <helped|not-needed|wrong> <id>...
kb trash <id>...             kb restore <id>...
kb delete <id>...            kb empty-trash
kb trash|restore|delete|empty-trash --scope <repo id>   a whole project
kb stale [--repo .]          kb verify <id>...
kb budget [--repo .]
kb scope [--repo .]          kb serve     (local page: read, edit and trash notes)
kb audit [--no-wait]         kb audit propose   kb audit status   (an agent audits the scope)
kb instructions [--repo .]   kb sync      kb checkpointed <session-id>
kb log [--session id] [--since days]      (what the log says of each note, or of one session)
kb unsaved [--forget <session-id>]   sessions here that ended with no checkpoint
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

Skills: `/kb:checkpoint`, `/kb:recover`, `/kb:audit`. Only you can start them. `/kb:note` writes a rule the
user states to an instruction file, and the agent starts it on its own.

`kb log` prints one row per note: how often a session got it as a body, as an index line or not at
all, how often an agent opened it (for a task, and as a check), how often a trigger loaded it, and its
verdicts. `--since <days>` takes the last days only. `--session <id>` prints the events of one
session in time order, and the notes that session got and has not judged yet. The rows count the
events of this machine. `last_activity` is the newest over all machines. A session that gives a
verdict twice judged the note once: its last verdict counts. A verdict with no session counts once
per note, verdict and day.

Every command accepts `--json`. The CLI knows nothing about Claude Code: only `hooks/` and `skills/` do.
There is one exception. A command names its session in the log with `--session <id>`, or else
`KB_SESSION`, or else `CLAUDE_CODE_SESSION_ID`, which Claude Code sets for each command an agent runs.

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

While it is on, the first start of each session asks the agent to tell you, and every session start tells the agent to save nothing there. With it off, that rule is not sent. `/kb:checkpoint` empties it: rules go to instruction files, and facts go to kb.

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
