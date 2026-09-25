#!/usr/bin/env bash
# Delayed-response probes (infrastructure investigation only).
# A: public-internet path via tailscale funnel (real TLS egress through local NAT/ISP) — curl, 20 min
# B: tailnet-direct control — curl, 20 min
# C: OpenRouter real-edge idle-flow probe — openssl s_client, declared 1MB body never sent, hold 21 min
set -u
cd "$(dirname "$0")"; mkdir -p logs
TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }
FUNNEL_URL="$1"   # e.g. https://fedora.tailnet-name.ts.net
DELAY_MS=1200000

echo "$(TS) [A-start] curl via FUNNEL (public TLS egress), delay=${DELAY_MS}ms"
curl -s -o logs/A-funnel-curl-body.txt -w "A-RESULT code=%{http_code} total=%{time_total}s\n" \
  --max-time 1500 "${FUNNEL_URL}/delay20?d=${DELAY_MS}&tag=A-curl" 2>&1
RC=$?
echo "$(TS) [A-end] curl exit=$RC $( [ -s logs/A-funnel-curl-body.txt ] && cat logs/A-funnel-curl-body.txt )"

echo "$(TS) [B-start] curl via TAILNET-DIRECT control, delay=${DELAY_MS}ms"
curl -s -o logs/B-tailnet-curl-body.txt -w "B-RESULT code=%{http_code} total=%{time_total}s\n" \
  --max-time 1500 "http://100.107.11.28:8443/delay20?d=${DELAY_MS}&tag=B-curl" 2>&1
RC=$?
echo "$(TS) [B-end] curl exit=$RC $( [ -s logs/B-tailnet-curl-body.txt ] && cat logs/B-tailnet-curl-body.txt )"

echo "$(TS) [C-start] openssl s_client to openrouter.ai:443 — POST with Content-Length: 1000000, body never sent, hold 21min"
( printf 'POST /api/v1/chat/completions HTTP/1.1\r\nHost: openrouter.ai\r\nAuthorization: Bearer invalid-idle-probe\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n'
  sleep 1260 ) | openssl s_client -quiet -connect openrouter.ai:443 -servername openrouter.ai 2>&1 \
  | while IFS= read -r line; do echo "$(TS) [C] $line"; if echo "$line" | grep -qE 'HTTP/|closed|error|errno'; then echo "$(TS) [C-NOTE] notable line above"; fi; done
echo "$(TS) [C-end] s_client probe finished"
