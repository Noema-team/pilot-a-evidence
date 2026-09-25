# Route decision — OpenRouter for future runs (operator directive, 2026-09-19)

- Operator directed: all future runs use OpenRouter. Persisted in the pilot driver seed
  (pilot-a-driver.ts, untracked experiment infra): settings.json now written as
  provider=openrouter, model=z-ai/glm-5.3-flash, max_tokens=16384, api_key_env=OPENROUTER_API_KEY.
- NOT changed: Stratum production source (resolveLLMProvider defaults untouched — per-project
  settings.json remains the mechanism), frozen baselines (stratum fa51e8a, target 86ec087),
  E5 preregistration text, closed Pilot A evidence.
- Verification (preflight-before-freeze discipline):
  - Credits: 181 total, 148.59 used -> ~32.4 remaining (HTTP 200).
  - Live probe z-ai/glm-5.3-flash via OpenRouter: HTTP 200, model served (16-token probe shows
    reasoning-token overhead, expected for this hybrid reasoner; pilot budget is 16384).
- Caveats recorded for the next preregistration (facts, not recommendations):
  - E4-H recorded 4 provider-degradation interruptions on THIS route (long-generation stalls)
    and remaining credit is finite. Pilot A's Z.ai failures were also long-call transport drops.
    Route switching is an operator decision; neither route has a clean long-call record.
  - Pilot A remains CLOSED: DIAGNOSED FAILURE. This change does not retroactively alter it.
  - The next preregistration must freeze this route explicitly (E5 rule: verify before freeze,
    0 mid-run changes) and budget OpenRouter credit.
