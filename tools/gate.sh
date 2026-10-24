#!/usr/bin/env bash
# Great Plan verification gate.
#
#   bash tools/gate.sh     # exit 0 = green
#
# Green proves: every JS file parses, and all node:test host tests pass.
# It does NOT prove: real DSH Host/Client wiring, slot props, model catalog
# behavior, compaction backend behavior, session creation, locale switching,
# or rendered UI (see AGENTS.md "Gate" blind spots). Those need the GUI
# checklist in AGENTS.md.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if [[ -n "${DSH_HOME:-}" ]]; then
    local candidate
    for candidate in "$DSH_HOME"/dsh-runtimes/*/dependencies/node/bin/node; do
      if [[ -x "$candidate" ]]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done
  fi
  return 1
}

if ! NODE="$(find_node)"; then
  echo 'gate: Node.js not found.' >&2
  echo 'gate: install Node.js, run this script from a DSH profile shell (DSH_HOME set),' >&2
  echo 'gate: or call the bundled runtime node explicitly.' >&2
  exit 1
fi

echo "gate: node $("$NODE" --version) ($NODE)"

echo 'gate: G-SYNTAX'
for file in index.js host/*.js client*.js; do
  "$NODE" --check "$file"
done

echo 'gate: G-TEST'
"$NODE" --test test/*.test.js

echo 'gate: green'
