# Gate A — Pilot A10 — ALL CHECKS PASS

**Date:** 2026-09-21 19:21–19:25 UTC. Deterministic only. **ZERO model invocations** (fixture + gates exercised no provider; journal carries only `a10_*` / `gate_b_*` events after the A9 history).

| # | Check | Result |
| --- | --- | --- |
| 1 | Resolver selects the INTENDED Definition from the frozen `definitionSource` | ✅ `gate_b_resolved`: sourceWorkItemId `wi-define-108-a8`, artifact `1aeb5d03…`, ref `definition:obj-108`, path `.sle/work/wi-define-108-a8/definition.md` |
| 2 | Hash matches the preregistered pin | ✅ `71f1c39c97ecea575b1195b63de510fa403dad4fecaa1df0c774d04fae89cac5` |
| 3 | Bytes byte-identical to the A8 evidence copy | ✅ `diff` clean vs `evidence/a8-definition-materialized.md` (16,141 bytes) |
| 4 | Two-lane context assembles (verbatim Definition, ordinary within ceiling) | ✅ probe: `token_count 4213 / hard_ceiling 4000 / includes_definition true` |
| 5 | E19 scoping output contract present at execution revision `37c3acd` | ✅ `outputArtifact: CYCLE_CHARTER_OUTPUT` on `FULL_BUILD.scoping.produce`; exact `## Scope` grammar in prompt |
| 6 | Scoping publication reaches approval deterministically | ✅ `tests/e19-scoping-publication.test.ts` 6/6 at this revision |
| 7 | Zero model calls across fixture + Gate A | ✅ journal: `a10_bytes_transplanted` → `a10_authority_pinned` → `gate_b_resolved` → `gate_b_probe_assemble`; no dispatch, no provider call |
| 8 | Driver `0ffea302…` (preregistered) · node 22 · key | ✅ hash verified at Gate A open |

Fixture state (wiped + rebuilt `.sle`): exactly 2 WIs (`wi-define-108-a8` completed / `wi-exec-108` ready with pinned `definitionSource` + dependency edge), 2 hash-pinned artifact rows, 1 historical run row (A8 define-work), fresh schema-valid map, inert budget override on disk.

**Gate A verdict: PASS — T0 authorized: `drive wi-exec-108` is the first real full-build model invocation.**
