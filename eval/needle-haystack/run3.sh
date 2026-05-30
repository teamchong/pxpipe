#!/usr/bin/env bash
# Eval v2: verbatim retrieval vs semantic comprehension, pixelpipe ON vs OFF.
# 15 trials per (mode, cond) = 60 calls total.
set -u
cd "$(dirname "$0")"

PROXY="http://127.0.0.1:47821"
MODEL="claude-opus-4-8"
N=15
RESULTS=results2.tsv
LOG=runs2.log
: > "$RESULTS"; : > "$LOG"
echo -e "mode\tcond\ttrial\texpected\tgot\tmatch\tdur_s" >> "$RESULTS"

# Filler is the same ~5KB tool-doc-looking block from run.sh
gen_filler() { sed -n '/^=== Internal Tool Reference/,/^EOF$/p' run.sh | sed '1d;$d'; }

toggle() {
  curl -s -X POST "$PROXY/api/compression" -H 'content-type: application/json' \
    -d "{\"enabled\":$1}" >/dev/null
  echo ">>> compression=$1" | tee -a "$LOG"
}

# --- VERBATIM mode: needle hex string ---
run_verbatim() {
  local cond=$1 trial=$2
  local key="N$(openssl rand -hex 4)"
  local val="$(openssl rand -hex 6)"
  local needle="VARIABLE ${key} IS ASSIGNED THE VALUE ${val} — REMEMBER THIS EXACT VALUE."
  local filler; filler="$(gen_filler)"
  local n_lines; n_lines=$(echo "$filler" | wc -l | tr -d ' ')
  local insert_at=$((n_lines / 2))
  local hay; hay="$(echo "$filler" | awk -v L="$insert_at" -v N="$needle" 'NR==L{print N} {print}')"
  local prompt="What is the value assigned to ${key}? Reply with ONLY the value (the hex string after the equals sign), no other words."

  local t0=$(date +%s) out
  out=$(ANTHROPIC_BASE_URL="$PROXY" claude -p --model "$MODEL" \
        --append-system-prompt "$hay" "$prompt" 2>>"$LOG" | tr -d '\r' | head -c 300)
  local dur=$(( $(date +%s) - t0 ))
  local got; got=$(echo "$out" | grep -oE '[0-9a-f]{12}' | head -1)
  local match=0; [[ "$got" == "$val" ]] && match=1
  echo -e "verbatim\t${cond}\t${trial}\t${val}\t${got}\t${match}\t${dur}" | tee -a "$RESULTS"
}

# --- SEMANTIC mode: question whose answer is in the filler ---
# Pool of (question, accepted-regex) pairs drawn from gen_filler() content.
declare -a Q EXP
Q+=("What is the default timeout in milliseconds for net.fetch?");                EXP+=("30000")
Q+=("How many redirect hops will net.fetch follow before giving up?");            EXP+=("10")
Q+=("What is the default line limit for fs.read_file?");                          EXP+=("2000")
Q+=("To how many characters are long lines truncated in fs.read_file?");          EXP+=("2000")
Q+=("What is the maximum value size for cache.set in KB?");                       EXP+=("256")
Q+=("What is the LRU eviction cap for the cache in MB?");                         EXP+=("64")
Q+=("What is the default refill rate for the token bucket in ops per second?");   EXP+=("10")
Q+=("What is the burst capacity for the rate limiter?");                          EXP+=("30")
Q+=("What is the max value for time.sleep in milliseconds?");                     EXP+=("600000")
Q+=("How many in-flight tool calls before the scheduler serializes?");            EXP+=("32")
Q+=("How many bytes can proc.spawn buffer for stdout before truncating? Answer with number of MB.");  EXP+=("8")
Q+=("What is the DNS cache TTL in seconds for net.dns_lookup?");                  EXP+=("60")
Q+=("What is the default timeout in milliseconds for db.query?");                 EXP+=("5000")
Q+=("Up to how many entries does fs.list_dir return before pagination?");         EXP+=("10000")
Q+=("What is the default timeout in milliseconds for proc.spawn?");               EXP+=("60000")

run_semantic() {
  local cond=$1 trial=$2
  local idx=$(( (trial - 1) % ${#Q[@]} ))
  local q="${Q[$idx]}"
  local exp="${EXP[$idx]}"
  local filler; filler="$(gen_filler)"
  local prompt="${q} Reply with ONLY the numeric value, no units, no other words."

  local t0=$(date +%s) out
  out=$(ANTHROPIC_BASE_URL="$PROXY" claude -p --model "$MODEL" \
        --append-system-prompt "$filler" "$prompt" 2>>"$LOG" | tr -d '\r' | head -c 300)
  local dur=$(( $(date +%s) - t0 ))
  local got; got=$(echo "$out" | grep -oE '[0-9]+' | head -1)
  local match=0; [[ "$got" == "$exp" ]] && match=1
  echo -e "semantic\t${cond}\t${trial}\t${exp}\t${got}\t${match}\t${dur}" | tee -a "$RESULTS"
}

echo "=== verbatim / OFF ==="; toggle false
for i in $(seq 1 $N); do run_verbatim off $i; done
echo "=== verbatim / ON ===";  toggle true
for i in $(seq 1 $N); do run_verbatim on  $i; done
echo "=== semantic / OFF ==="; toggle false
for i in $(seq 1 $N); do run_semantic off $i; done
echo "=== semantic / ON ===";  toggle true
for i in $(seq 1 $N); do run_semantic on  $i; done
toggle true

echo; echo "=== SUMMARY ==="
awk -F'\t' 'NR>1 {k=$1"/"$2; n[k]++; ok[k]+=$6}
  END {for (k in n) printf "%-12s  %2d/%2d  %5.1f%%\n", k, ok[k], n[k], 100*ok[k]/n[k]}' "$RESULTS" | sort
