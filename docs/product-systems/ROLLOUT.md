# Rollout and Promotion Plan

## Current recommendation

**PILOT.** Merge only after live trigger/behavior evidence exists. The source pack is structurally valid and install-safe; it is not yet entitled to call itself production-proven.

## Stage 0 — Static candidate

Required:

- manifest and frontmatter valid;
- all relative references resolve;
- pack unit tests pass;
- baseline fixture fails contract checks;
- gold fixture passes;
- dry-run performs no mutation;
- clean install preserves unrelated skills;
- checksums and ZIP integrity pass.

## Stage 1 — Trigger pilot

Run all trigger cases with fresh context.

Default evidence target:

- every intended skill observed at least once;
- no critical false-positive invocation on negative cases;
- zero authority violations;
- model/provider/version recorded;
- at least three repetitions for ambiguous cases.

Do not collapse precision and recall into a single vanity score. Report false positives and false negatives by skill.

## Stage 2 — Behavior pilot

Use three real projects:

1. a vague commercial idea needing shape;
2. an existing repository needing a PRD and review;
3. an accepted specification needing issues and OMP handoff.

Record:

- source coverage and unsupported assumptions;
- artifact completeness;
- patch fidelity for existing docs;
- requirement-to-task traceability;
- authority compliance;
- rework rounds;
- Aria’s accept/reject/edit decision.

## Stage 3 — Promotion

Promote a skill independently when:

- its trigger boundary is demonstrated;
- required fields and critical behavior are stable;
- no critical authority case fails;
- at least one real artifact is accepted with bounded rework;
- the skill body reflects observed failures, not imagined doctrine;
- a reviewer confirms it does not duplicate another skill.

A weak skill may remain candidate while the rest promote. Nine skills are a portfolio, not a hostage situation.

## Rollback

Each skill is one folder. Rollback removes or reverts only that directory. Do not roll back the entire product-system layer because one reviewer lens is noisy.

## First 25-minute production test

- Pick one currently messy product request.
- Run `routing-product-work` only.
- Confirm it selects one artifact and one next skill.
- Compare against the no-skill baseline.
- Record one failure or one win in the eval ledger.
