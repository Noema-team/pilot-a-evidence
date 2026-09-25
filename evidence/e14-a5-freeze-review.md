# E14 — A5 freeze review: A4 per-turn ledger (zero model calls), 2026-09-20

Question ordered before A5: were A4's 38 tool calls productive investigation, repeated
exploration, or a failure to transition from exploration to synthesis?

## Findings (from a4-runs/051c2f65…/synthesize-definition-loop.json)

- **38 calls, 38 unique paths, ZERO repeated calls.** No file or directory was ever
  re-read. Repetition is ruled out.
- Tool mix: 22 list_directory (surveying) vs 16 read_file (depth).
- Area coverage: rag-worker-service 12 + rag-api-service 10 = 22 calls on the two services
  #108 is about — the core was covered, thoroughly and without repetition.
- **Divergence, not repetition**: turns 16–23 expanded to peripheral areas —
  flashcard-service (2), functions/src incl. denormalization.ts (4), tests (2), docs (4),
  plans/todo/docker-compose (3). The final calls (turns 22–23) were listing
  docs/system-overview/ai-server — a survey of an UNRELATED subsystem, still widening
  scope at the cap.
- No synthesis signals anywhere: no submit attempt, no draft-shaped behavior; the run
  ended mid-expansion with the widest-scope calls last.

## Classification

**Productive but non-converging investigation — a failure to transition from exploration
to synthesis.** Not repeated exploration (0 repeats), not model failure (every call
succeeded). The model never decided it knew enough.

## Implication for the decision matrix (recorded, not acted on)

If A5 also exhausts with a similar trajectory, additional turns would likely buy MORE
wandering, not convergence — the operator's warned pattern. The variance question (is
this a one-off?) is exactly what the unchanged A5 rerun answers: A3 submitted at turn 15;
A4 never submitted by 24. A5 decides between "variance" (submits ≤24) and "systematic
non-convergence" (exhausts again — then the lever is submission discipline, e.g. a
submit-by-turn-N expectation in methodology text or a scoped turn-cap experiment, NOT an
automatic cap raise).

No prompt, driver, or frozen-input edits made or proposed mid-experiment.
