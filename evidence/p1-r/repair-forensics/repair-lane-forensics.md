# P1-R repair-lane forensics — op2 (99100d24) and op3 (fb79af13)

Offline replay against the REAL contract code at the frozen commit. Zero model traffic.
Evidence: `evidence/p1-r/p1-r-3/` and `p1-r-5/` (both include `build-rejected-result.json` —
the full normalized rejected proposals, archived by the E8/A2 mechanism).

---

## 1. Exact rejection/repair state reconstruction

### Loop mechanics (agent-loop.ts, frozen)
- `MAX_AGENT_TURNS = 24`; `MAX_RESULT_REPAIRS = 1` ("Do not raise" — transport/step-result.ts:281).
- On a rejected submission the repair instruction is delivered as a tool_result and the loop continues;
  the SECOND rejection fails the step closed (`resultRepairDecision(1) → fail-closed`).

### op2 — 99100d24 (BUILD opportunity 2)
- Initial submission: 29,228 B compact JSON, schema-valid; 3 edits + 1 create.
  - create: `apps/ai-server/tests/integration/test_worker_failure_contract.py` (13.1 KB — a sophisticated,
    hermetic, high-quality contract test — and **impossible under this policy**: `allowedEditPaths=[main.py]`
    is an existing file, so **every create is out-of-policy by construction**).
  - edits: [30,99], [905,1024], [1024,1103] on main.py (ids deterministically inverted against base 7d7718bc…).
  - Rejection: `unauthorized-create-path` + `overlapping-edits` ([905,1024]+[1024,1103] share line 1024).
- Repair turn: the completion truncated at **32,768 completion tokens** (`finish_reason: length`,
  `stop_reason: max_tokens`) without producing a resubmission → step failed. Turns used: 19/24.

### op3 — fb79af13 (BUILD opportunity 3)
- Initial submission: 9,688 B, **schema-invalid** (missing the required `creates` key).
  Rejection: `creates: Required` — schema rejection pre-empts anchor validation.
- Repair turn: the model **did resubmit** (2,172 completion tokens ≈ the full proposal size) —
  and the resubmission **still lacked `creates`** → rejection #2 → `MAX_RESULT_REPAIRS` exhausted →
  fail closed at turn 18/24. **Capacity was sufficient; instruction-following was the failure.**

---

## 2. Minimum completion capacity per repair (bytes → tokens ≈ B/3.6)

| | corrected proposal | size | ≈ tokens | within one 32,768-token completion? |
|---|---|---|---|---|
| op2 minus create | `{edits:[3], creates:[]}` | 16,211 B (create was 13.0 KB of the original) | ~4.5K | trivially yes |
| op2 merged single-edit form | edits A+B composed + [30,99] | 16,111 B | ~4.5K | trivially yes |
| op3 plus `creates:[]` | `{edits:[1], creates:[]}` | 9,701 B | ~2.7K | trivially yes |

Capacity is NOT the binding constraint for either repair. The archived failures had different roots:

- op2: the repair truncated because the model regenerated/reasoned past the envelope — while the needed
  artifact was ~16 KB of **its own already-written text** (A and B were byte-identical to what it submitted;
  the correction is a mechanical rearrangement).
- op3: capacity was used and sufficient; the model resubmitted the same defective shape.

---

## 3. op2's overlap: genuinely conflicting or boundary geometry?

**Boundary geometry — proven, not argued.**
- Base line 1024 (shared by both inclusive ranges) is the `_publish_status_update(… "embeddings_complete", "progress": 80 …)` call.
- Replacement A (for [905,1024]) ends with a line **byte-identical** to replacement B's (for [1024,1103])
  first line: `A[-1] === B[0]` (both carry the model's new version of line 1024).
- The union is therefore unambiguous: `merged = A + B[1:]` (drop the duplicated boundary line).
- **Offline validation against the real contract**: the merged single edit (on a hypothetical covering
  anchor [905,1103]) + the [30,99] edit + `creates:[]` → **zero defects** — a fully valid changeset.

The model did exactly what the read tool's windowing invites: two neighboring reads whose inclusive
ranges share the boundary line, then edits on both. The rejection is *semantically correct* under
inclusive ranges (applying both would double-define line 1024) — but the conflict is an artifact of
range representation, and the composition is mechanically decidable (identical boundary line ⇒ merge).

**The expressibility trap**: under current mechanics the corrected op2 proposal is NOT expressible
without new anchors — no minted anchor covers [905,1103], and repository tools are withdrawn during
repair. A tool-less repair lane, however generous, had **no valid proposal available to produce**.
Only one of these fixes it:
- **P2-B (anchor composition)**: Stratum auto-merges boundary-adjacent edits whose shared-line
  replacements are identical (deterministic, validate-time, zero model change). Under this rule,
  **op2's initial submission minus the create was already a first-pass-valid changeset** (proven:
  merged form validates with zero defects) — the repair round never needed to happen.
- or minting covering anchors at read time (wider model-facing change, not required by the evidence).

---

## 4. Would one dedicated tool-less repair completion have been sufficient?

- **op2: NO — regardless of capacity.** No valid proposal is expressible tool-less (§3). The repair
  lane would have truncated, or worse, "succeeded" by dropping one of the two edits (losing required
  changes). With **P2-B**, op2 needs no repair at all.
- **op3: capacity yes — but insufficiency is proven by the archive**: the model HAD its one repair,
  reproduced the same missing key. Moreover, the naive fix (+`creates:[]`) then hits
  **`unknown-anchor`**: op3's only edit's anchor id (`src_3efbb118…`) inverts to **no slice of any
  file the model read** (worker main.py, rag-api main.py, three test files — exhaustively searched)
  — an unfounded or unreproducible id that the schema rejection masked. The naive repair would have
  failed a second time → `MAX_RESULT_REPAIRS=1` → terminal anyway.

Two deterministic normalizations would have moved BOTH failures off the model:
1. **Policy-aware creates**: under a policy whose allowed paths all exist, `creates` can only be `[]` —
   the contract can inject/reject this statically (teaching: "this task authorizes no creates").
   Removes op2's create (13 KB) and the entire P1-1 class before the model ever reasons about it.
2. **Missing-`creates` normalization** (absent key ≡ empty) or making `creates` optional-with-default:
   turns op3's shape defect into a no-op — the proposal would have proceeded to real validation
   (anchor check), surfacing the true defect (`unknown-anchor`) on the FIRST pass with an actionable
   message while the model still had its one repair for the real problem.

---

## 5. Decision matrix for the operator

| intervention | op2 | op3 | notes |
|---|---|---|---|
| **P2-A alone** (bounded repair reserve, tools withdrawn) | ✗ — no valid proposal expressible | ✗ likely — model re-sent the broken shape; masked `unknown-anchor` next | capacity was never the archived bottleneck |
| **P2-B alone** (composition + the two normalizations) | ✓ — first-pass valid, no repair needed | partial — clean first-pass rejection names the real defect; the single repair then addresses it | deterministic, zero model-facing change beyond teaching |
| **P2-A + P2-B** | ✓ | ✓ best odds — normalization + composition leave the repair lane for genuine model errors | the repair lane returns to its intended role |

Additional frozen-regime observation: upstream budget failures (design/plan `max_tokens`, runs 2 and 4)
are a separate variance source not addressed by either P2 variant.

*Replay script: `/tmp/opencode/op2op3-repair-replay.mts` (archived to evidence/p1-r/repair-forensics/).
All claims re-runnable offline against the archived payloads and the frozen contract code.*
