# Sourced by the hooks and bin/ launchers: sets BUN to the bun that runs kb, or to "" when there
# is none. Claude Code gives hooks the PATH it started with, and an app started from a desktop or
# a login item often has no ~/.bun/bin or Homebrew folder on it. So after PATH, this looks where
# the bun installer and Homebrew put bun. KB_BUN_SYSTEM_DIRS replaces the system folders, so a
# test can take them away.
BUN=$(command -v bun 2>/dev/null) || BUN=
if [ -z "$BUN" ]; then
  for kb_candidate in "${BUN_INSTALL:+$BUN_INSTALL/bin/bun}" "${HOME:+$HOME/.bun/bin/bun}"; do
    if [ -n "$kb_candidate" ] && [ -f "$kb_candidate" ] && [ -x "$kb_candidate" ]; then
      BUN=$kb_candidate
      break
    fi
  done
fi
if [ -z "$BUN" ]; then
  for kb_dir in ${KB_BUN_SYSTEM_DIRS-/opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin}; do
    if [ -f "$kb_dir/bun" ] && [ -x "$kb_dir/bun" ]; then
      BUN=$kb_dir/bun
      break
    fi
  done
fi
unset kb_candidate kb_dir

# What a user sees when there is no bun anywhere: one sentence, with every place that was searched.
# It holds no quote or backslash, because session-start.sh puts it into JSON as it is.
BUN_MISSING="Bun is not on the PATH, in \$BUN_INSTALL/bin, in ~/.bun/bin, or in the Homebrew folders. Install it from bun.sh."
