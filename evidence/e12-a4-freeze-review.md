# E12 — A4 freeze review (zero model calls), 2026-09-20

Purpose: establish, from stored evidence only, whether the repair instruction named the
allowed values, whether the rejected payload otherwise passed validation, and whether the
source/kind confusion hypothesis holds — before freezing A4.

## 1. What is stored (and what is not)

- `-loop.json` `rejected_result`: bounded description of the LAST rejection (turn 16) +
  the exact repair instruction delivered after rejection 1 (turn 15).
- `synthesize-definition-rejected-result.json`: the normalized LAST submission (the
  turn-16 resubmission), 15,550 bytes, sha256 5072e641cd62a2f4….
- NOT stored: the turn-15 original submission's payload (bounded design keeps the last
  submission only) and original wire bytes (never captured, by design). The original
  rejection's reason IS preserved — it is quoted inside the stored repair instruction.

## 2. Both rejections named the SAME single defect

- Repair instruction (after rejection 1), verbatim: "…facts.13.kind: Invalid enum value.
  Expected 'product-intent' | 'repository-claim', received 'artifact'…"
- Final failure (after rejection 2, from step failure_json): identical path, identical
  received value. The model repeated the exact same violation after feedback.

## 3. The resubmission passed EVERYTHING ELSE — single defect mechanically proven

Re-validating the stored 15,550-byte payload against the actual `DEFINITION_PROPOSAL_SCHEMA`:
exactly ONE zod issue exists (`facts.13.kind`). Deleting `facts[13].kind` (omission is
legal — the schema marks kind optional) makes the ENTIRE payload VALID. The proposal was
mechanically one vocabulary token away from acceptance.

## 4. The source/kind confusion is visible in the data

The resubmission's fact ledger (14 facts): 9× `kind='repository-claim'` (source
'repository'), 1× `kind='product-intent'` (source 'human'), 3× `kind` OMITTED (sources
'investigation' — legal omission, so the model knows omission is allowed), and the
DEFERRED fact [13]: `kind='artifact'`, `source='artifact'`. It used 'artifact' in BOTH
fields — for a deferred fact pointing at an artifact, 'artifact' is the correct SOURCE
and an invalid KIND. The repair feedback named the path and the allowed values, and the
model still repeated it: the failure is a field-vocabulary collision, not missing
enumeration knowledge.

## 5. Teaching claims verified in code (src/workflow/methodology/definition-contract.ts)

- `/facts/items/kind` annotation: "Optional: 'product-intent' or 'repository-claim'. One
  mechanical rule…" — enum, optionality, and allowed values ARE already taught.
- `/facts/items/source` annotation: "Where the fact came from: human, repository,
  artifact, investigation, or decision…" — 'artifact' is legitimately a SOURCE value.
- Nothing in the teaching says the two vocabularies are disjoint, or that 'artifact'
  belongs to source only. Adding an exhaustive enumeration would repeat what the model
  already received (and used correctly elsewhere).

## 6. Conclusion → A4 freeze

One narrow change is justified: strengthen the generated teaching to explicitly
disambiguate the two fields ('artifact' is a source, never a kind; omit kind when
neither classification fits — deferral is expressed via status). Schema, validator,
materializer, and the 1-repair budget stay unchanged. MAX_RESULT_REPAIRS stays at 1 —
raising it now (with a prompt change in the same run) would confound A4's result;
defer to a later experiment if A4 still shows repair-capacity problems.
