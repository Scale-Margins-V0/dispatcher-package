#!/usr/bin/env bash
# Self-check for the version derivation in .github/workflows/build-and-push.yml.
#
# It does NOT reimplement the logic — it extracts the shell block straight out
# of the workflow and runs it with `git log` stubbed. If someone edits the
# workflow and breaks the bump rules, this fails.
#
#   ./scripts/test-version-bump.sh
#
# ponytail: no framework, no fixtures — the whole point is that it is one file
# you can run in a second. Move it into CI as its own job if it ever earns it.
set -uo pipefail
cd "$(dirname "$0")/.."

WF=.github/workflows/build-and-push.yml
BLOCK=$(mktemp)
trap 'rm -f "$BLOCK"' EXIT

python3 - "$WF" "$BLOCK" <<'PY'
import re, sys
src, out = sys.argv[1], sys.argv[2]
s = open(src).read()
m = re.search(r'(            LEVEL="\$\{IN_BUMP:-auto\}".*?\n            esac\n)', s, re.S)
if not m:
    sys.exit("could not find the derivation block in " + src +
             " — did the indentation or the LEVEL= line change?")
block = m.group(1)
open(out, "w").write(
    "\n".join(l[12:] if l.startswith(" " * 12) else l for l in block.split("\n"))
)
PY

derive() {
  local CURRENT="$1" IN_BUMP="$2" LAST_TAG="v0" NEXT LEVEL MA MI PA DERIVED
  export _SUBJ="$3" _BODY="$4"
  git() {
    case "$*" in
      *"--format=%B"*) printf '%s\n' "$_BODY" ;;
      *"--format=%s"*) printf '%s\n' "$_SUBJ" ;;
    esac
  }
  # shellcheck disable=SC1090
  source "$BLOCK" >/dev/null 2>&1
  echo "$NEXT"
}

fail=0
check() {
  if [ "$2" = "$3" ]; then printf '  ✅ %-46s %s\n' "$1" "$3"
  else printf '  ❌ %-46s expected %s got %s\n' "$1" "$2" "$3"; fail=1; fi
}

echo "auto-derivation (a push event sends bump=auto):"
check "fix only -> patch"              "0.3.1"  "$(derive 0.3.0 auto 'fix(db): typo' 'fix(db): typo')"
check "refactor -> patch"              "0.3.1"  "$(derive 0.3.0 auto 'refactor(logging): x' 'x')"
check "feat present -> minor"          "0.4.0"  "$(derive 0.3.0 auto 'fix: a
feat(api): b' 'x')"
check "bang breaking on 0.x -> minor"  "0.4.0"  "$(derive 0.3.0 auto 'feat(api)!: drop v0' 'x')"
check "BREAKING CHANGE body on 0.x"    "0.4.0"  "$(derive 0.3.0 auto 'feat: x' 'BREAKING CHANGE: nope')"
check "bang breaking on 1.x -> major"  "2.0.0"  "$(derive 1.4.2 auto 'feat!: drop v0' 'x')"
check "empty bump string -> derives"   "0.3.1"  "$(derive 0.3.0 '' 'fix: x' 'x')"

echo "explicit override:"
check "manual major on 0.x -> 1.0.0"   "1.0.0"  "$(derive 0.3.0 major 'fix: x' 'x')"
check "manual minor"                   "0.4.0"  "$(derive 0.3.0 minor 'fix: x' 'x')"
check "manual patch despite feat"      "0.3.1"  "$(derive 0.3.0 patch 'feat: x' 'x')"

echo "edges:"
check "no commits -> patch"            "0.3.1"  "$(derive 0.3.0 auto '' '')"
check "prerelease current stripped"    "0.3.1"  "$(derive '0.3.0-dev.abc1234' auto 'fix: x' 'x')"
check "double-digit minor"             "1.10.0" "$(derive 1.9.3 auto 'feat: x' 'x')"
check "feat mid-body does not count"   "0.3.1"  "$(derive 0.3.0 auto 'fix: x' 'this feat: no')"
check "9 -> 10 patch"                  "1.2.10" "$(derive 1.2.9 auto 'fix: x' 'x')"
check "revert: -> patch"               "0.3.1"  "$(derive 0.3.0 auto 'revert: bad feat' 'x')"

[ $fail -eq 0 ] && echo && echo "all version-bump cases pass"
exit $fail
