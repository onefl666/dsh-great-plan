#!/usr/bin/env bash
# Evaluation harness gate (repository-only; not part of the plugin gate).
#
#   bash tools/gate-eval.sh     # exit 0 = green
#
# Proves: every eval JS file parses, and the eval offline test suite passes.
# It does not prove: a live DSH SDK run, model behavior, or resolve rate.
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
  echo 'gate-eval: Node.js not found.' >&2
  echo 'gate-eval: install Node.js, run this script from a DSH profile shell (DSH_HOME set),' >&2
  echo 'gate-eval: or call the bundled runtime node explicitly.' >&2
  exit 1
fi

echo "gate-eval: node $("$NODE" --version) ($NODE)"

echo 'gate-eval: G-SYNTAX'
while IFS= read -r file; do
  "$NODE" --check "$file"
done < <(find eval/interactive-swe -name '*.mjs' -type f | sort)

echo 'gate-eval: G-TEST'
"$NODE" --test eval/test/*.test.mjs

echo 'gate-eval: green'
