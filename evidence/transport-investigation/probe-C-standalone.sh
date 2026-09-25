#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"; mkdir -p logs
TS() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "$(TS) [C-start] openssl s_client to openrouter.ai:443 — POST Content-Length:1000000 never sent, hold 21min"
( printf 'POST /api/v1/chat/completions HTTP/1.1\r\nHost: openrouter.ai\r\nAuthorization: Bearer invalid-idle-probe\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n'; sleep 1260 ) | openssl s_client -quiet -connect openrouter.ai:443 -servername openrouter.ai 2>&1 | while IFS= read -r line; do echo "$(TS) [C] $line"; done
echo "$(TS) [C-end] finished"
