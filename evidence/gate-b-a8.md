# Gate B — Pilot A8 (live DDR-041 verification) — PASS

**Date:** 2026-09-21 14:40 UTC. Deterministic only.

After `execute-wi wi-define-108-a8` (driver-authoritative order):

```
GATE B PASS: sha256 71f1c39c97ec | probe token_count 4213 / 4000 | verbatim: true
{"event":"gate_b_resolved","sourceWorkItemId":"wi-define-108-a8","artifactId":"…","ref":"definition:obj-108",
 "path":".sle/work/wi-define-108-a8/definition.md","sha256":"71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5", …}
{"event":"gate_b_probe_assemble","token_count":4213,"hard_ceiling":4000,"includes_definition":true}
```

- Source WI completed ✓ · D.1 provenance ✓ · sha256 pin ✓ (matches the on-disk 16,525→16,913-byte A8 Definition) · ref/path resolved ✓.
- Context assembly: **4,213 tokens total with `hard_ceiling` 4,000 and `includes_definition: true`** — the PR #32 two-lane invariant working in production: the verbatim Definition rides its reserved lane; ordinary fixed components fit 4,000. The exact boundary that terminated A7 is crossed with a real model-produced Definition.

**H1: CROSSED.** For the first time in the series, a fresh, readiness-passed, provenance-pinned canonical Definition passed Gate B and full-build began executing with real model calls.
