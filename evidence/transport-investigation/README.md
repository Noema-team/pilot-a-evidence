# Transport Investigation — attempts 20/21 UND_ERR_SOCKET failures

**Date:** 2026-09-25 (UTC timestamps throughout) · **Host:** fedora (tailscale 100.107.11.28), same machine/network as attempts 20/21
**Scope:** infrastructure-only, outside the frozen experiment. No Stratum changes, no attempt 22.
**Environment:** Fedora Linux · Node v22.17.0 (bundled undici **6.21.2** — the engine's actual HTTP stack; stratum uses plain `fetch`, no custom dispatcher) · curl 8.9.1 / OpenSSL 3.2.6 · openssl CLI 3.2.6 · direct internet egress (no proxy env vars, no Tailscale exit node; tailscale is device-interconnect only)

## Failure under investigation

Attempts 20/21 both died at the TEST-step finalization completion call:
`TypeError → SocketError UND_ERR_SOCKET "other side closed"` after **525,792 ms (8.8 min)** and **788,746 ms (13.1 min)** respectively.
Engine uses **non-streaming** completions (no `stream` usage in src/llm-provider.ts): request fully sent, response arrives only when generation completes.

**Preferred journal wording (per operator):**
> The repeated long-idle failure pattern is consistent with an in-flight connection being terminated somewhere on the client→OpenRouter→upstream path. The responsible layer and exact timeout mechanism remain unproven.

## Probes & results

| # | Probe | Condition tested | Result | Classification |
|---|-------|------------------|--------|----------------|
| B | Controlled delayed-response server (this repo, `delayed-server.mjs` on :8443), reached **tailnet-direct** `http://100.107.11.28:8443`, curl | Request sent → **zero response bytes 20 min** → 200 | **COMPLETED**: `code=200 total=1200.011s`, server logged `held=1200013ms` (05:57:23Z→06:17:23Z) | Server mechanism validated; no-funnel baseline. Same-host path — does NOT traverse internet NAT |
| A | Same server via **tailscale funnel** (public HTTPS egress through local NAT/ISP) | Same 20-min zero-byte condition over the real internet path | **NOT RUN — ruled out by operator (2026-09-25): remaining attribution value not necessary for the Stratum engineering decision; network-forensics branch closed** | — |
| C | **OpenRouter real-edge idle** (openssl s_client → openrouter.ai:443, Cloudflare 2606:4700::6812:273, GTS cert): POST with `Content-Length: 1000000`, **body never sent**, hold | Upload-idle: declared body never completes | **RESET at 15.0 s** both runs: `read:errno=104` (ECONNRESET) — 05:57:38→05:57:53Z and 06:17:23→06:17:38Z. **Reproducible 2/2** | Upload-idle timeout on OpenRouter's public path. **Conservative attribution per operator:** establishes the public path does not tolerate upload-idle; does NOT establish the same component/policy caused attempts 20/21 |
| D-curl | curl: models GET; small non-streaming completion; streaming (max_tokens 3000) | Ordinary traffic + streaming chunk cadence | GET 200 @ 0.14 s; completion 200 @ 2.0 s; streaming TTFT ~1 s, 548 chunks logged, all gaps sub-second | GET/completion VALID; **streaming run INVALID / HARNESS-CENSORED** — local SIGPIPE from the display pipeline truncated it at ~9 s. Not transport evidence |
| D-node | Fresh Node process (undici 6.21.2): GET, small non-streaming completion, streaming with metrics | Engine-stack streaming behavior | GET 200 @ 0.2 s; completion 200 @ 1.8 s; **streaming COMPLETED: TTFT 1.01 s, 116 chunks / 28.0 s, largest inter-chunk gap 0.28 s** | VALID — the streaming observation of record |

## Distinctions preserved (per operator)

1. **Upload-idle timeout** — probe C: edge resets ~15 s when the declared request body never completes. Reproducible 2/2. Establishes path strictness for THIS state only.
2. **Post-upload / pre-response-byte timeout** — the attempts 20/21 condition (request fully sent, generation in progress, zero response bytes 8.8/13.1 min). Reproduced only against the controlled server (B ✓ 20 min on tailnet; **A pending**). Against OpenRouter this condition has NOT been directly probed (would require a real long generation = the experiment itself). The 15 s upload-idle result does **not** establish the same limit applies post-upload — response-wait is plausibly treated differently (origin marks the flow active), which would explain how the attempts survived 8+ min.
3. **Streaming inter-chunk behavior** — D-node (valid): continuous bytes, max gap 0.28 s ⇒ a streaming generation is never byte-idle mid-flight; an idle-flow killer cannot act during streaming generation. (D-curl streaming: HARNESS-CENSORED, excluded.)
4. **Local harness failures** — A-first-attempt used a placeholder URL (curl exit 6, instant, before funnel existed); D-curl SIGPIPE truncation. Both logged here as harness artifacts, not network events.

## Working hypotheses (closed — A not run)

Per operator ruling, the local-vs-remote attribution experiment (A) was NOT run. **The exact component that reset attempts 20/21 remains unattributed.** What the investigation establishes, conservatively:

- Attempts 20/21 were **transport-censored** (connection terminated mid-request, failure at the transport layer, no H2 result).
- The current **non-streaming** transport can leave a completion request without application-response bytes for long periods (observed 8.8/13.1 min); the OpenRouter public path demonstrably enforces strict idle policy for the *upload-idle* state (15 s resets, 2/2), while the *post-upload response-wait* state is plausibly governed by a different policy (unproven).
- **Streaming** demonstrably avoids the byte-idle condition during the observed generation (continuous chunks, max gap 0.28 s).
- **Not proven:** responsibility of OpenRouter, CGNAT, the router, the ISP, Undici, or the upstream model — none is attributed.

## Regime boundary (explicit)

Streaming (`stream: true`, SSE/incremental parsing) changes request/response transport semantics and failure modes. It must **not** be silently substituted into a future "attempt 22" while claiming identical experimental conditions — adopting it is an explicit regime boundary / comparability decision, recorded as such in the journal, and belongs to a separate transport-hardening change.

## Raw evidence

`logs/` — server.log (every connection phase), delays-B-C.log, C-openrouter-edge-idle.log, D-curl-openrouter.log (incl. HARNESS-CENSORED streaming), D-node-openrouter.log, A-funnel-*.log (pending). Harness: delayed-server.mjs, probe-A.sh, probe-delays.sh, probe-C-standalone.sh, probe-node-openrouter.mjs. All timestamps UTC.

## Cleanup record

1. Funnel: NEVER enabled (config denied; would have required sudo; ruled out before use) — `tailscale funnel status` → "No serve config" ✓ nothing to reset
2. `delayed-server.mjs` on :8443 — stopped, port verified free ✓
3. No key material in any log (verified by grep) ✓
