#!/usr/bin/env bun
// Seeds a throwaway store that looks like months of real use, for manual walks of the product.
// Every name here is invented. The output is the same on every run.
//
//   bun scripts/seed.ts <empty-dir>
//
// It writes <dir>/store (use it as KB_HOME), <dir>/repos/<name> (git repos with fake origin
// remotes) and <dir>/plain (a directory outside every repo).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logEvent } from "../cli/log.ts";
import { type Kind, type Note, slugify } from "../cli/note.ts";
import { Store } from "../cli/store.ts";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || (existsSync(root) && readdirSync(root).length > 0)) {
  console.error("usage: bun scripts/seed.ts <empty-dir>");
  process.exit(1);
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "kb seed",
  GIT_AUTHOR_EMAIL: "kb@example.com",
  GIT_COMMITTER_NAME: "kb seed",
  GIT_COMMITTER_EMAIL: "kb@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// A fixed clock: "today" for the seeded store. Ages below are days before it.
const NOW = Date.parse("2026-11-16T09:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

// A small deterministic generator, so that ages and activity vary without Math.random.
let seed = 7;
const next = (max: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % max;
};

const store = new Store(join(root, "store"));
store.ensure();
mkdirSync(join(root, "plain"), { recursive: true });

interface Seed {
  title: string;
  kind: Kind;
  body: string;
  /** Days since the note was last verified. */
  age?: number;
  /** Times a session opened the note for a task. They go to the event log. */
  opened?: number;
  anchors?: string[];
  /** When the note loads outside the session start: a command or an error text. */
  triggers?: string[];
  confidence?: Note["confidence"];
}

const taken = new Set<string>();
let total = 0;

function put(scope: string, head: string | undefined, s: Seed): void {
  let id = slugify(s.title);
  for (let n = 2; taken.has(id); n++) id = `${slugify(s.title)}-${n}`;
  taken.add(id);
  const age = s.age ?? next(170);
  const note: Note = {
    id,
    title: s.title,
    scope,
    kind: s.kind,
    created: daysAgo(age + next(60)),
    last_verified: daysAgo(age),
    anchors: s.anchors ?? [],
    confidence: s.confidence ?? "medium",
    body: s.body,
  };
  if (s.triggers) note.triggers = s.triggers;
  if (head && scope !== "global") note.verified_at_commit = head;
  store.writeNote(note);
  const opened = s.opened ?? (next(3) === 0 ? next(6) : 0);
  const last = next(Math.max(1, age));
  for (let i = 0; i < opened; i++) logEvent(store, { ev: "show", note: id, why: "task", scope }, new Date(NOW - (last + i * 3) * 86_400_000));
  total++;
}

const para = (text: string, times: number) => Array.from({ length: times }, (_, i) => `${text} (case ${i + 1})`).join("\n");

// ---- global: 46 notes. Gotchas the user must never lose, standing rules, a few procedures. ----

const GLOBAL: Seed[] = [
  // Gotchas. Several are long, as they get after months of additions.
  { kind: "gotcha", title: "Never run the migration tool against the shared staging database", opened: 9, age: 3, triggers: ["stop: migrate up"], body: "The staging database at db.staging.example.com is shared by four teams. `migrate up` there dropped a column in use.\nRun migrations on a local copy only. Ask the user to run the staging step." },
  { kind: "gotcha", title: "The deploy CLI exits 0 when the upload was rejected", opened: 6, age: 12, triggers: ["cmd: shipit deploy"], body: "Only `\"status\":\"live\"` in the JSON output means deployed. Check it every time.\n" + para("A rejected upload prints a warning line and still exits 0, so a script that checks only the exit code reports a deploy that did not happen.", 5) },
  { kind: "gotcha", title: "Background agents cannot answer a permission prompt", opened: 4, age: 20, body: "A prompt in a background agent times out and is denied. Ask for `mktemp -d` directories and script files instead of `rm` in a compound command." },
  { kind: "gotcha", title: "A load test can outlive its run and pin the machine for hours", opened: 3, age: 31, body: "Every load or loop needs a hard time limit and cleanup on exit.\n" + para("A burner process started to reproduce a flake kept all cores busy long after the session ended, and nobody saw it until the fans started.", 4) },
  { kind: "gotcha", title: "The build host has no route to the office network", age: 40, body: "It reaches the internet only. Anything that needs the office network becomes a command for the user.\n" + para("Requests to internal names time out after 30 seconds without an error message, which looks like a slow service and not like a blocked route.", 6) },
  { kind: "gotcha", title: "The package registry mirror serves stale versions for an hour", age: 55, triggers: ["err: no matching version found"], body: "After a publish, `install` can get the old version for up to 60 minutes. Pin the exact version and pass `--prefer-online`." },
  { kind: "gotcha", title: "Screen recording permission resets after each OS update", age: 62, body: "The capture tool then records a black frame and exits 0. Check the first frame before a long recording." },
  { kind: "gotcha", title: "The repo edit command ignores a positional repo name", age: 70, triggers: ["cmd: forge repo edit"], body: "It edits the repo of the current directory. Always pass `-R owner/repo`." },
  { kind: "gotcha", title: "The operating system blocks agents from reading the Downloads folder", age: 75, body: "Ask the user to move the file to /home/user/work first. This holds for shell commands too." },
  { kind: "gotcha", title: "Rebase of a published branch drops review comments", age: 90, triggers: ["cmd: git rebase"], body: "Merge the default branch into a published PR head. Never rebase it: the review tool loses the comment anchors." },
  { kind: "gotcha", title: "The review pipeline writes local paths into its report", age: 101, body: "Remove `/home/user/...` paths from the report before it goes into a PR body." },
  { kind: "gotcha", title: "The notification tool reports success when nothing was shown", age: 120, body: "Only `\"shown\":true` means delivered.\n" + para("The exit code is 0 in both cases, and the text output is the same, so only the JSON field tells the two apart.", 4) },
  { kind: "gotcha", title: "Preview links expire after seven days", age: 140, body: "A link in an old PR can be dead. Make a new preview before the user is asked to look." },
  { kind: "gotcha", title: "The staging database is shared, never run migrations against it", age: 200, body: "Older wording of the same rule. Staging is shared by several teams." },
  { kind: "gotcha", title: "Time zone of the CI runners is UTC, not local", age: 230, body: "Date tests that pass on the laptop can fail in CI between 00:00 and 01:00 local time." },
  { kind: "gotcha", title: "The old VPN client breaks DNS for containers", age: 300, confidence: "low", body: "Seen once in January. Restart the container runtime after the VPN connects." },

  // Conventions: the largest group, most of them one or two lines.
  { kind: "convention", title: "Give one firm recommendation and hold it", opened: 5, age: 8, body: "Do not list options without a choice. Change the recommendation only for new facts." },
  { kind: "convention", title: "Secrets never go on a command line or into a file in the repo", opened: 4, age: 15, body: "Read them from the environment. If a command needs one, the user runs it." },
  { kind: "convention", title: "Name the project in every status update", age: 18, body: "The user reads updates from many sessions in one place." },
  { kind: "convention", title: "Names are one short plain English word", age: 22, body: "No abbreviations, no codenames, no version suffix in a name." },
  { kind: "convention", title: "Name the model and effort for every subagent", age: 25, body: "Use a cheaper model for search and a strong one for review. Say which." },
  { kind: "convention", title: "Visual work goes through a quick mock first", age: 28, body: "A static page or a script that the user can try in a minute. Build after the user agrees." },
  { kind: "convention", title: "Projects without users ship by direct PR with a short description", age: 33, body: "No release notes, no migration plan." },
  { kind: "convention", title: "Stay off the user's screen and test headless", opened: 2, age: 35, body: "Never open a window. Ask before any step that needs the screen." },
  { kind: "convention", title: "Which projects merge green PRs without asking", age: 37, body: "atlas-api and tidepool: merge when green. All others: ask, and name the PR number." },
  { kind: "convention", title: "State AI use truthfully where an outside project asks", age: 44, body: "Follow the contribution rules of that project." },
  { kind: "convention", title: "A fix for a failure the user hit also adds the test", age: 47, body: "The test fails before the fix and passes after." },
  { kind: "convention", title: "A fix that needs a release bumps the version in the same PR", age: 52, body: "Otherwise the fix sits unreleased for days." },
  { kind: "convention", title: "Check it yourself before asking the user whether it works", age: 58, body: "Run it. Ask only for what cannot be checked from here." },
  { kind: "convention", title: "Every command handed to the user is one block to paste", age: 60, body: "No placeholders to fill in, no line that must be edited first." },
  { kind: "convention", title: "Everything deploys through the hosted build service", age: 66, body: "No deploy from a laptop. A deploy happens only from the default branch." },
  { kind: "convention", title: "Research results and design choices go on a page, not into chat", age: 72, body: "Chat scrolls away. A page can be reviewed and annotated." },
  { kind: "convention", title: "Tests cover behavior that can break silently", age: 80, body: "Do not add a test that restates the code." },
  { kind: "convention", title: "Visible changes get a few representative before and after pictures", age: 85, body: "Two or three pairs. Mark what changed." },
  { kind: "convention", title: "Commit visual snapshot references when they buy review speed", age: 95, body: "Keep them small and few." },
  { kind: "convention", title: "Check for a clean path before offering a workaround", age: 105, body: "A workaround is the last choice." },
  { kind: "convention", title: "Never walk the user through manual checks step by step", age: 110, body: "Automate the check, or give one command." },
  { kind: "convention", title: "Offer an independent review before asking for a merge", age: 125, body: "A second reader finds what the author cannot see." },
  { kind: "convention", title: "State the success criterion as a check before work starts", age: 150, body: "A command and its expected output." },
  { kind: "convention", title: "Audio for videos uses real recorded sound", age: 190, body: "No synthesized effects." },
  { kind: "convention", title: "Prefer tabs in Makefiles and two spaces elsewhere", age: 260, body: "From an old project. Most repos have a formatter now." },

  // Decisions, procedures and open work that belong to no single repo.
  { kind: "decision", title: "One private repo holds the notes of every machine", age: 130, body: "A store per machine was tried and drifted in a week." },
  { kind: "decision", title: "Dotfiles own every tool install", age: 160, body: "No ad hoc installs. A tool that is not in dotfiles does not exist on the next machine." },
  { kind: "how-to", title: "Checks and deploys by project", opened: 3, age: 9, body: para("atlas-api: `make check`, deploy by merge to main. Others follow the same shape with their own task name.", 9) },
  { kind: "how-to", title: "Publish a file for the user to open", age: 50, body: "Copy it under /home/user/pub and hand over the https://files.example.com link. Test the link first." },
  { kind: "open-work", title: "Move the last two laptops to the new shell setup", age: 6, body: "Done: the desktop and the build host. Left: both laptops. Blocked on the keychain export." },
];

// ---- repos: 9 projects, 12 notes each. ----

const REPOS: { name: string; remote: string; domain: string; file: string }[] = [
  { name: "atlas-api", remote: "git@github.com:example-org/atlas-api.git", domain: "billing", file: "src/billing.ts" },
  { name: "tidepool", remote: "https://github.com/example-org/tidepool.git", domain: "sync", file: "src/sync.ts" },
  { name: "lantern-web", remote: "git@github.com:example-org/lantern-web.git", domain: "rendering", file: "src/render.ts" },
  { name: "quarry", remote: "git@github.com:example-org/quarry.git", domain: "indexing", file: "src/index.ts" },
  { name: "harbor-cli", remote: "https://github.com/example-org/harbor-cli.git", domain: "packaging", file: "src/pack.ts" },
  { name: "mosaic", remote: "git@gitlab.example.com:studio/mosaic.git", domain: "tiles", file: "src/tiles.ts" },
  { name: "ferry", remote: "git@github.com:example-org/ferry.git", domain: "queue", file: "src/queue.ts" },
  { name: "orchard", remote: "https://github.com/example-org/orchard.git", domain: "scheduler", file: "src/schedule.ts" },
  { name: "pebble-notes", remote: "", domain: "storage", file: "src/storage.ts" },
];

function repoNotes(name: string, domain: string, file: string): Seed[] {
  return [
    { kind: "open-work", title: `Finish the ${domain} retry rework in ${name}`, age: 2, body: `Done: the backoff table and its tests. Left: the dead-letter path in \`${file}\`. Next step: make \`retryAll\` idempotent.`, anchors: [file] },
    { kind: "gotcha", title: `${name} amounts are integer cents, never floats`, opened: 7, age: 5, anchors: [`${file}#total`], body: `A float in the ${domain} path gave totals that were off by one cent. Convert at the edge.` },
    { kind: "gotcha", title: `The ${name} test database must be reset between suites`, opened: 2, age: 30, triggers: [`cmd: make test-${domain}`], body: `Suites share one schema. Run \`make db-reset\` first, or ${domain} tests fail in a random order.` },
    { kind: "gotcha", title: `${name} cache keys include the tenant id`, age: 64, body: `A key without the tenant leaked ${domain} data between tenants in staging.\n${para(`Every helper that builds a key must take the tenant as its first argument, and the lint rule in ${name} checks only the helpers it knows.`, 5)}` },
    { kind: "gotcha", title: `The ${name} dev server needs port 4100 free`, age: 210, triggers: ["cmd: make dev", "err: module not found"], body: "It fails with a misleading \"module not found\" when the port is taken." },
    { kind: "convention", title: `${name} errors are values, not exceptions, in the ${domain} layer`, age: 45, body: "Return `{ ok: false, error }`. Throw only at the HTTP edge." },
    { kind: "convention", title: `${name} commits use the imperative and name the module`, age: 88, body: `For example: "${domain}: reject empty batches".` },
    { kind: "decision", title: `${name} keeps ${domain} state in one table`, age: 100, anchors: [file], body: `A second table was tried and the two went out of step. One table with a status column, and a nightly check.` },
    { kind: "decision", title: `${name} does not use an ORM`, age: 170, body: "Plain SQL with typed helpers. The ORM hid a slow query for a month." },
    { kind: "decision", title: `${name} keeps all ${domain} state in a single table`, age: 240, body: "Older note on the same choice. A status column, not a second table." },
    { kind: "how-to", title: `Release ${name}`, opened: 3, age: 14, body: `1. \`make check\`\n2. Bump the version in package.json.\n3. Merge to main. The build service deploys.\n4. Check https://${name}.example.com/health for the new version.` },
    { kind: "how-to", title: `Run the ${name} ${domain} suite against a local copy of the data`, age: 115, body: `${para(`Export with \`make export\`, load into the local database, remove the sign-in tables, and run \`make test-${domain}\`.`, 3)}` },
  ];
}

for (const s of GLOBAL) put("global", undefined, s);

for (const repo of REPOS) {
  const dir = join(root, "repos", repo.name);
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, repo.file), `export function total(): number {\n  return 0;\n}\n`);
  writeFileSync(join(dir, "README.md"), `# ${repo.name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  if (repo.remote) git(dir, "remote", "add", "origin", repo.remote);
  const head = git(dir, "rev-parse", "--short", "HEAD");
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "cli", "main.ts"), "scope", "--repo", dir], { env: { ...process.env, KB_HOME: store.home }, stdout: "pipe" });
  const scope = r.stdout.toString().trim();
  for (const s of repoNotes(repo.name, repo.domain, repo.file)) put(scope, head, s);
}

store.writeIndex();

console.log(`${total} notes`);
console.log(`export KB_HOME=${store.home}`);
console.log(`repos: ${join(root, "repos")}`);
console.log(`plain: ${join(root, "plain")}`);
