#!/bin/bash
# Why: remove the PATH symlink that after-install.sh created, but only if it
# still points into a Jaws install dir — never delete an unrelated
# /usr/bin/jaws a user or other package may own.
set -e

link="/usr/bin/jaws"

if [ -L "$link" ]; then
  target="$(readlink "$link" || true)"
  case "$target" in
    /opt/Jaws/*|/opt/jaws/*)
      rm -f "$link"
      ;;
  esac
fi

exit 0
