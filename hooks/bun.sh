# Sourced by the hooks and bin/ launchers: sets BUN to the bun that runs kb, or to "" when there
# is none. Claude Code gives hooks the PATH it started with, and an app started from a desktop or
# a login item often has no ~/.bun/bin or Homebrew folder on it. So after PATH, this looks where
# the bun installer and Homebrew put bun. KB_BUN_SYSTEM_DIRS replaces the system folders, so a
# test can take them away.
BUN=$(command -v bun 2>/dev/null) || BUN=
if [ -z "$BUN" ]; then
  for candidate in "${BUN_INSTALL:+$BUN_INSTALL/bin/bun}" "${HOME:+$HOME/.bun/bin/bun}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      BUN=$candidate
      break
    fi
  done
fi
if [ -z "$BUN" ]; then
  for dir in ${KB_BUN_SYSTEM_DIRS-/opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin}; do
    if [ -x "$dir/bun" ]; then
      BUN=$dir/bun
      break
    fi
  done
fi

# The one line a user sees when there is no bun anywhere.
BUN_MISSING="kb: Bun is not on the PATH that Claude Code gives hooks, or in ~/.bun/bin, so kb is off. Install it from bun.sh."
