#!/usr/bin/env bash
# Move Claude Code's auto memory into kb, one project at a time, with /kb:checkpoint <folder>.
#
#   scripts/move-auto-memory.sh --dry-run           list the folders and where each one runs
#   scripts/move-auto-memory.sh                     move every folder
#   scripts/move-auto-memory.sh <name>...           move only these folders (names under projects/)
#   scripts/move-auto-memory.sh -- --model sonnet   arguments after -- go to claude
#
# A run starts in the folder's project directory, so its repo facts get the repo's scope. When
# that directory is gone, it starts in $HOME and keeps only the facts that hold in every repo.
# All memory folders are saved to a tar file first. Each run's report is in a log file.
set -euo pipefail

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
dry_run=false
only=()
claude_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --) shift; claude_args=("$@"); break ;;
    *)
      # Folder names start with a -, so a name is anything that is a folder under projects/.
      [ -d "$config/projects/$1" ] || { echo "no folder or option $1 (folder names are under $config/projects)" >&2; exit 2; }
      only+=("$1") ;;
  esac
  shift
done

command -v claude >/dev/null || { echo "claude is not on PATH" >&2; exit 1; }

# The checkpoint skill that runs must take a folder. An older one ignores it and moves nothing.
plugin=""
for ((k = 0; k < ${#claude_args[@]}; k++)); do
  [ "${claude_args[k]}" = "--plugin-dir" ] && plugin="${claude_args[k + 1]:-}"
done
if [ -z "$plugin" ]; then
  plugin="$(grep -A3 '"kb@' "$config/plugins/installed_plugins.json" 2>/dev/null | grep -m1 -o '"installPath": *"[^"]*"' | cut -d'"' -f4 || true)"
fi
if ! grep -q 'ARGUMENTS' "$plugin/skills/checkpoint/SKILL.md" 2>/dev/null; then
  echo "the kb plugin at ${plugin:-(not found)} is too old: its /kb:checkpoint takes no folder." >&2
  echo "update it (claude plugin update kb@jrnxf), or pass -- --plugin-dir <kb checkout>." >&2
  exit 1
fi

# Claude Code names a project folder after its path, with each character that is not a letter or a
# digit changed to a -. (A name over 200 characters is cut and gets a hash: not handled here.)
slug() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }
# The first cwd of each transcript in a folder.
cwds() { grep -h -m1 -o '"cwd":"[^"]*"' "$1"/*.jsonl 2>/dev/null | cut -d'"' -f4 | sort -u || true; }
count() { find "$1" -maxdepth 1 -name '*.md' ! -name MEMORY.md | wc -l | tr -d ' '; }

# The project directory of a folder: a cwd from its transcripts, else its name read as a path
# (which misses a path with a - or other punctuation in it). The first that exists and gives the
# folder name wins. Empty when none does.
project_dir() {
  local folder="$1" name cwd rest
  name="$(basename "$folder")"
  while IFS= read -r cwd; do
    if [ -d "$cwd" ] && [ "$(slug "$cwd")" = "$name" ]; then printf '%s' "$cwd"; return 0; fi
  done < <(cwds "$folder"; printf '%s\n' "$name" | tr '-' '/')
  # A folder from an old home (another user name): the same path under this $HOME.
  [[ "$name" == -Users-* || "$name" == -home-* ]] || return 0
  rest="${name#-*-*-}"
  [ "$rest" != "$name" ] || return 0
  while IFS= read -r cwd; do
    if [ -d "$cwd" ] && [[ "$cwd" == "$HOME"/* ]] && [ "$(slug "${cwd#"$HOME"/}")" = "$rest" ]; then printf '%s' "$cwd"; return 0; fi
  done < <(cwds "$folder" | sed -E "s#^/(Users|home)/[^/]+#$HOME#"; printf '%s\n' "$HOME/$(printf '%s' "$rest" | tr '-' '/')")
  return 0
}

folders=()
for memory in "$config"/projects/*/memory; do
  [ -d "$memory" ] || continue
  name="$(basename "$(dirname "$memory")")"
  if [ ${#only[@]} -gt 0 ] && [[ ! " ${only[*]} " == *" $name "* ]]; then continue; fi
  # Only folders with a fact in them. MEMORY.md is just the index.
  if [ "$(count "$memory")" -gt 0 ]; then folders+=("$memory"); fi
done
[ ${#folders[@]} -gt 0 ] || { echo "no auto memory to move"; exit 0; }

if $dry_run; then
  for memory in "${folders[@]}"; do
    files="$(count "$memory")"
    dir="$(project_dir "$(dirname "$memory")")"
    printf '%3s files  %s\n           runs in %s\n' "$files" "$(basename "$(dirname "$memory")")" "${dir:-$HOME (project gone: global facts only)}"
  done
  echo "${#folders[@]} folders"
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backup="$config/auto-memory-backup-$stamp.tar.gz"
logs="$config/auto-memory-move-$stamp"
mkdir -p "$logs"
(cd "$config" && tar -czf "$backup" projects/*/memory)
echo "backup: $backup"
echo "logs:   $logs"

failed=0
untouched=0
i=0
for memory in "${folders[@]}"; do
  i=$((i + 1))
  name="$(basename "$(dirname "$memory")")"
  dir="$(project_dir "$(dirname "$memory")")"
  log="$logs/$name.md"
  before="$(count "$memory")"
  printf '[%d/%d] %s ... ' "$i" "${#folders[@]}" "$name"
  # Auto memory is off for the run, so it cannot write a new memory while it moves the old ones.
  # Only user settings load: a project's own hooks (a Stop hook that waits, for one) can hang -p.
  if (cd "${dir:-$HOME}" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p "/kb:checkpoint $memory" --setting-sources user ${claude_args[@]+"${claude_args[@]}"} </dev/null >"$log" 2>&1); then
    after="$(count "$memory")"
    # claude exits 0 also when a write or an rm was refused, so the files left are the real check.
    [ "$after" -lt "$before" ] || untouched=$((untouched + 1))
    echo "$((before - after)) of $before files moved, see the log for the skipped ones"
  else
    failed=$((failed + 1))
    echo "failed, see $log"
  fi
done

left="$(find "$config"/projects/*/memory -maxdepth 1 -name '*.md' ! -name MEMORY.md 2>/dev/null | wc -l | tr -d ' ')"
echo "done: ${#folders[@]} folders, $failed failed, $untouched with no file moved, $left memory files left (skipped facts stay)"
