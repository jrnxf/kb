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

# The project directory of a folder: the first cwd its transcripts recorded, when it still exists
# and its name gives the folder name.
project_dir() {
  local folder="$1" name cwd
  name="$(basename "$folder")"
  # First a cwd from the transcripts, then the name read as a path (which misses a path with a - or
  # a . in it). The first that exists and gives the folder name wins.
  for cwd in $(grep -h -o '"cwd":"[^"]*"' "$folder"/*.jsonl 2>/dev/null | cut -d'"' -f4 | sort -u) "$(printf '%s' "$name" | tr '-' '/')"; do
    if [ -d "$cwd" ] && [ "$(printf '%s' "$cwd" | tr '/.' '--')" = "$name" ]; then
      printf '%s' "$cwd"
      return
    fi
  done
  # A folder from an old home (another user name): the same path under this $HOME.
  local home rest
  home="$(printf '%s' "$HOME" | tr '/.' '--')"
  case "$name" in "$home"* | -Users-* | -home-*) ;; *) return ;; esac
  rest="${name#-*-*-}"
  [ "$rest" != "$name" ] || return
  for cwd in $(grep -h -o '"cwd":"[^"]*"' "$folder"/*.jsonl 2>/dev/null | cut -d'"' -f4 | sort -u | sed -E 's#^/(Users|home)/[^/]+#'"$HOME"'#') "$HOME/$(printf '%s' "$rest" | tr '-' '/')"; do
    if [ -d "$cwd" ] && [ "${cwd#"$HOME"/}" != "$cwd" ] && [ "$(printf '%s' "${cwd#"$HOME"/}" | tr '/.' '--')" = "$rest" ]; then
      printf '%s' "$cwd"
      return
    fi
  done
}

folders=()
for memory in "$config"/projects/*/memory; do
  [ -d "$memory" ] || continue
  name="$(basename "$(dirname "$memory")")"
  if [ ${#only[@]} -gt 0 ] && [[ ! " ${only[*]} " == *" $name "* ]]; then continue; fi
  # Only folders with a fact in them. MEMORY.md is just the index.
  if find "$memory" -maxdepth 1 -name '*.md' ! -name MEMORY.md | grep -q .; then folders+=("$memory"); fi
done
[ ${#folders[@]} -gt 0 ] || { echo "no auto memory to move"; exit 0; }

if $dry_run; then
  for memory in "${folders[@]}"; do
    count="$(find "$memory" -maxdepth 1 -name '*.md' ! -name MEMORY.md | wc -l | tr -d ' ')"
    dir="$(project_dir "$(dirname "$memory")")"
    printf '%3s files  %s\n           runs in %s\n' "$count" "$(basename "$(dirname "$memory")")" "${dir:-$HOME (project gone: global facts only)}"
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
i=0
for memory in "${folders[@]}"; do
  i=$((i + 1))
  name="$(basename "$(dirname "$memory")")"
  dir="$(project_dir "$(dirname "$memory")")"
  log="$logs/$name.md"
  printf '[%d/%d] %s ... ' "$i" "${#folders[@]}" "$name"
  # Auto memory is off for the run, so it cannot write a new memory while it moves the old ones.
  # Only user settings load: a project's own hooks (a Stop hook that waits, for one) can hang -p.
  if (cd "${dir:-$HOME}" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p "/kb:checkpoint $memory" --setting-sources user ${claude_args[@]+"${claude_args[@]}"} </dev/null >"$log" 2>&1); then
    grep -m1 -o 'Safe to clear.*\|Not safe to clear.*' "$log" | tr -d '*' || echo "done, see the log"
  else
    failed=$((failed + 1))
    echo "failed, see $log"
  fi
done

left="$(find "$config"/projects/*/memory -maxdepth 1 -name '*.md' ! -name MEMORY.md 2>/dev/null | wc -l | tr -d ' ')"
echo "done: ${#folders[@]} folders, $failed failed, $left memory files left (skipped facts stay)"
