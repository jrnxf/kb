# Sourced by the hooks and bin/ launchers: sets BUN to the bun that runs kb, or to "" when there
# is none. Claude Code gives hooks the PATH it started with, and an app started from a desktop or
# a login item often has no ~/.bun/bin or Homebrew folder on it. So the search is: KB_BUN, then
# the PATH, then the folders where the bun installer, Homebrew, mise and asdf put bun.
# KB_BUN_SYSTEM_DIRS (folders split on ":") replaces the system folders, so a test can take them away.
kb_is_bun() { [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ]; }

BUN=
if kb_is_bun "${KB_BUN-}"; then
  BUN=$KB_BUN
else
  BUN=$(command -v bun 2>/dev/null) || BUN=
fi
if [ -z "$BUN" ]; then
  kb_ifs=$IFS
  case $- in *f*) kb_noglob=1 ;; *) kb_noglob=; set -f ;; esac
  IFS=:
  kb_home=${HOME:+$HOME/.bun/bin:$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.asdf/shims:$HOME/.linuxbrew/bin}
  for kb_dir in ${BUN_INSTALL:+$BUN_INSTALL/bin} $kb_home ${KB_BUN_SYSTEM_DIRS-/opt/homebrew/bin:/usr/local/bin:/home/linuxbrew/.linuxbrew/bin}; do
    if kb_is_bun "$kb_dir/bun"; then
      BUN=$kb_dir/bun
      break
    fi
  done
  IFS=$kb_ifs
  [ -n "$kb_noglob" ] || set +f
  unset kb_ifs kb_noglob kb_home kb_dir
fi

# What a user sees when there is no bun anywhere: one sentence. It holds no quote or backslash,
# because session-start.sh puts it into JSON as it is.
BUN_MISSING="Bun is not on the PATH or in the usual install folders (~/.bun/bin, ~/.local/bin, mise, asdf, Homebrew). Set KB_BUN to the path of bun, or install it from bun.sh."

# kb_need_bun [name]: succeeds when there is a bun. Otherwise it fails, and with a name it also
# prints "<name>: <BUN_MISSING>" on stderr. A hook calls it without a name and exits 0 on failure.
kb_need_bun() {
  [ -n "$BUN" ] && return 0
  [ -z "${1-}" ] || echo "$1: $BUN_MISSING" >&2
  return 1
}
