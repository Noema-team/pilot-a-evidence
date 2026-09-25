#!/usr/bin/env bash
# Variant A — public-internet egress via tailscale funnel: request fully sent,
# ZERO response bytes for 20 min, then 200. Run with: probe-A.sh <funnel-url>
# Runs BOTH clients (curl + node/undici) in parallel; each is the engine-relevant
# condition "response pending, flow byte-idle".
set -u
cd "$(dirname "$0")"; mkdir -p logs
TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }
URL="$1"; DELAY=1200000

echo "$(TS) [A-start] funnel=$URL delay=${DELAY}ms — curl and node in parallel"

( S=$(TS); echo "$S [A-curl] start"
  curl -s -o logs/A-funnel-curl-body.txt -w "A-CURL-RESULT code=%{http_code} total=%{time_total}s exit=%{exitcode}" \
    --max-time 1500 "${URL}/delay20?d=${DELAY}&tag=A-curl" 2>&1
  echo "$(TS) [A-curl] end body=$(cat logs/A-funnel-curl-body.txt 2>/dev/null)" ) \
  > logs/A-funnel-curl.log 2>&1 &

( node -e '
const t0 = Date.now(); const ts = () => new Date().toISOString();
fetch(process.argv[1], { method: "GET" })
  .then(async r => { const b = await r.text();
    console.log(`${ts()} [A-node] COMPLETED status=${r.status} total=${((Date.now()-t0)/1000).toFixed(1)}s body=${b.slice(0,60)}`); })
  .catch(e => console.log(`${ts()} [A-node] FAILED after ${((Date.now()-t0)/1000).toFixed(1)}s: ${e.name}/${e.cause?.code ?? e.message} cause_msg="${e.cause?.message}"`));
' "${URL}/delay20?d=${DELAY}&tag=A-node" ) > logs/A-funnel-node.log 2>&1 &

wait
echo "$(TS) [A-end] both clients finished"
cat logs/A-funnel-curl.log logs/A-funnel-node.log
