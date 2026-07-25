#!/usr/bin/env bash
# Shared model selection for the pxpipe demos (cost-ab + effective-context).
# Sourced by setup.sh / a.sh / b.sh in both demos so they never disagree.
#
# WHY THIS FILE CONTAINS NO MODEL NAMES
# ------------------------------------
# The demos used to carry their own `case` table: `opus) MODEL=claude-opus-4-8`.
# That is a second, competing copy of a list the product already maintains, and it
# rots exactly the way you would expect — `opus` still meant claude-opus-4-8 long
# after claude-opus-5 shipped, so a run labelled "opus" quietly measured the old
# model. Replacing that constant with a newer one is not a fix; it just re-pins the
# same trap one version forward.
#
# So: the model list is READ FROM THE PRODUCT, never written here.
#   src/core/applicability.ts :: DEFAULT_MODEL_BASES   <- the one source of truth
#   exported at runtime as     getConfiguredModelBases()
# When a new model ships, someone edits applicability.ts (they must anyway, it is
# what production compresses) and these demos follow automatically. Nothing to
# update in demo/.
#
# SELECTION (first non-empty wins)
#   1. CLI arg            bash b.sh <full-model-id>  (or a unique shorthand: `opus`)
#   2. $PXPIPE_DEMO_MODEL
#   3. whatever setup.sh recorded for this demo (so a.sh/b.sh inherit it)
#   4. the product's own first default base
#
# A shorthand like `opus` is resolved by UNIQUE SUBSTRING MATCH against the live
# list — not a lookup table — so it tracks whatever is actually shipping. If it is
# ambiguous or matches nothing, we stop and print the real candidates rather than
# guess a model name for you.

# Repo root, located by walking up to the file we read the model list from. Seeded
# from this script's own path when the shell provides it and from $PWD otherwise:
# $BASH_SOURCE is a bashism and is EMPTY under zsh, which would silently resolve the
# root one level too high and make every lookup fail. Never assume the caller's cwd.
_demo_find_root() {
  local seed d
  for seed in "$@"; do
    [ -n "$seed" ] || continue
    d="$(cd "$seed" 2>/dev/null && pwd)" || continue
    while [ -n "$d" ] && [ "$d" != "/" ]; do
      if [ -f "$d/src/core/applicability.ts" ]; then printf '%s' "$d"; return 0; fi
      d="$(dirname "$d")"
    done
  done
  return 1
}
DEMO_REPO_ROOT="$(_demo_find_root "$(dirname "${BASH_SOURCE[0]:-${0:-.}}")" "$PWD")" || {
  echo "demo/models.sh: cannot locate the pxpipe repo root (no src/core/applicability.ts above" >&2
  echo "  $(dirname "${BASH_SOURCE[0]:-${0:-.}}") or $PWD)" >&2
  return 1 2>/dev/null || exit 1
}

DEMO_PORT_ON="${PXPIPE_DEMO_PORT_ON:-47824}"    # pxpipe      -> b.sh (right)
DEMO_PORT_OFF="${PXPIPE_DEMO_PORT_OFF:-47823}"  # passthrough -> a.sh (left)
DEMO_STATE_DIR="${PXPIPE_DEMO_STATE_DIR:-/tmp/pxpipe-demo}"

# The product's current default compress scope, one base per line.
#
# `env -u PXPIPE_MODELS` matters: getConfiguredModelBases() honours that env var
# over the built-in default, and it is very easy to still have one exported from an
# earlier demo/eval run in the same shell. Without the -u we would report a stale
# leftover as "the default" and pin the demo to the wrong model — the exact class of
# bug this file exists to kill.
demo_known_bases() {
  local out
  if [ -f "$DEMO_REPO_ROOT/dist/core/index.js" ]; then
    out=$(cd "$DEMO_REPO_ROOT" && env -u PXPIPE_MODELS node -e \
      "import('./dist/core/index.js').then(m=>console.log(m.getConfiguredModelBases().join('\n')))" \
      2>/dev/null)
    if [ -n "$out" ]; then printf '%s\n' "$out"; return 0; fi
  fi
  # dist not built yet (a.sh/b.sh never build) — read the same constant from source.
  sed -n 's/^const DEFAULT_MODEL_BASES *= *\[\(.*\)\];.*/\1/p' \
      "$DEMO_REPO_ROOT/src/core/applicability.ts" \
    | tr ',' '\n' | sed 's/[^A-Za-z0-9._-]//g' | grep -v '^$'
}

# Resolve a user-supplied model into DEMO_MODEL_BASE (scope key, no [variant]) and
# DEMO_MODEL_ID (what --model receives, variant included).
demo_resolve_model() {
  local want="${1:-}" bases stripped variant matches n
  [ -n "$want" ] || want="${PXPIPE_DEMO_MODEL:-}"

  bases="$(demo_known_bases)"
  if [ -z "$bases" ]; then
    echo "demo/models.sh: could not read DEFAULT_MODEL_BASES from the product." >&2
    echo "  looked in: dist/core/index.js and src/core/applicability.ts" >&2
    return 1
  fi

  [ -n "$want" ] || want="${PXPIPE_DEMO_DEFAULT:-$(printf '%s\n' "$bases" | head -1)}"

  # Split a trailing [variant] tag (e.g. [1m]); scope matching uses the bare base.
  case "$want" in
    *\[*) stripped="${want%%\[*}"; variant="[${want#*\[}" ;;
    *)    stripped="$want";        variant="${PXPIPE_DEMO_VARIANT:-}" ;;
  esac

  if printf '%s\n' "$bases" | grep -qxF "$stripped"; then
    DEMO_MODEL_BASE="$stripped"                       # exact, in default scope
  else
    matches="$(printf '%s\n' "$bases" | grep -F -- "$stripped" || true)"
    n="$(printf '%s' "$matches" | grep -c . || true)"
    if [ "$n" -eq 1 ]; then
      DEMO_MODEL_BASE="$matches"                      # unique shorthand, resolved live
    elif [ "$n" -gt 1 ]; then
      echo "'$stripped' is ambiguous — it matches several shipping models:" >&2
      printf '%s\n' "$matches" | sed 's/^/  /' >&2
      echo "Pass the full model id." >&2
      return 1
    elif [ "${stripped#*-}" != "$stripped" ]; then
      DEMO_MODEL_BASE="$stripped"                     # full id outside default scope
    else
      echo "'$stripped' is not a model name and matches nothing currently shipping." >&2
      echo "Known model bases (from src/core/applicability.ts):" >&2
      printf '%s\n' "$bases" | sed 's/^/  /' >&2
      echo "Pass one of those, a unique substring of one, or a full model id." >&2
      return 1
    fi
  fi

  DEMO_MODEL_ID="$DEMO_MODEL_BASE$variant"
  export DEMO_MODEL_BASE DEMO_MODEL_ID
}

# Compress scope = the product's own defaults ∪ the chosen model, deduped.
# Entries are BASES: the proxy strips [variant] tags before matching (see
# src/core/applicability.ts), so a base covers its [1m] form. Never add [1m] here —
# the stripped incoming base would stop equalling the entry and pxpipe would
# silently stop compressing.
demo_scope_for() {
  { demo_known_bases; printf '%s\n' "$1"; } | awk 'NF && !seen[$0]++' | paste -sd, -
}

demo_state_file() { printf '%s/%s.env' "$DEMO_STATE_DIR" "$1"; }

# setup.sh records what it armed; a.sh/b.sh read it so all three agree by default.
demo_write_state() {
  mkdir -p "$DEMO_STATE_DIR" || return 1
  cat >"$(demo_state_file "$1")" <<EOF
DEMO_STATE_NAME=$1
DEMO_STATE_MODEL_BASE=$2
DEMO_STATE_MODEL_ID=$3
DEMO_STATE_SCOPE=$4
DEMO_STATE_ANSWER=${5:-}
DEMO_STATE_PORT_ON=$DEMO_PORT_ON
DEMO_STATE_PORT_OFF=$DEMO_PORT_OFF
EOF
}

demo_load_state() {
  local f; f="$(demo_state_file "$1")"
  [ -f "$f" ] || return 1
  . "$f"
}

# a.sh/b.sh entry point: explicit arg/env wins, else inherit setup.sh's choice.
demo_resolve_column_model() {
  local demo="$1" arg="${2:-}"
  demo_load_state "$demo" 2>/dev/null || true
  [ -n "$arg" ] || arg="${PXPIPE_DEMO_MODEL:-}"
  [ -n "$arg" ] || arg="${DEMO_STATE_MODEL_ID:-}"
  demo_resolve_model "$arg"
}

# b.sh gate: refuse to run a model this proxy would pass through UNCOMPRESSED, which
# would look like a pxpipe result while measuring nothing.
demo_require_scope() {
  local demo="$1" base="$2"
  demo_load_state "$demo" 2>/dev/null || return 0     # no setup.sh yet — nothing to check
  case ",${DEMO_STATE_SCOPE:-}," in
    *",$base,"*) return 0 ;;
  esac
  cat >&2 <<EOF

REFUSING TO RUN — model not in the proxy's compress scope.

  this column wants : $base
  setup.sh armed    : ${DEMO_STATE_SCOPE:-<none>}

pxpipe would pass this model through UNCOMPRESSED, so the run would look like a
pxpipe result while measuring nothing. Re-arm the proxies for this model:

  bash demo/$demo/setup.sh $base

EOF
  return 1
}
