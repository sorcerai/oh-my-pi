# OMP Product Systems Skill Pack v1

A modular product-development layer for Oh My Pi. It reproduces the useful public behavior pattern behind specialized AI product-management tools—context grounding, structured product artifacts, inline critique, decomposition, and execution handoff—without copying private prompts, code, or hidden implementation details.

## Verdict

Install as a **candidate skill layer**, not a new control plane. OMP already owns worker orchestration, retained candidates, verification, and apply authority. This pack adds product judgment and artifact contracts.

## Included skills

| Skill | Job |
|---|---|
| `routing-product-work` | Select the smallest correct next product artifact. |
| `grounding-product-context` | Build a source-backed context packet before product decisions. |
| `shaping-product-bets` | Bound a raw idea into an evidence-aware product bet. |
| `authoring-prds` | Draft or surgically revise versioned product documents. |
| `red-teaming-prds` | Review product documents with explicit blockers and patches. |
| `decomposing-product-work` | Convert accepted requirements into risk-first vertical slices. |
| `handing-off-product-work` | Transfer bounded, traceable work to OMP or another executor. |
| `authoring-agent-skills` | Create or revise reusable OMP/Agent Skills packages. |
| `evaluating-agent-skills` | Test triggers, behavior, authority, variance, and regressions. |

## Core loop

```text
GROUND → SHAPE → SPECIFY → RED-TEAM → SLICE → HANDOFF → LEARN
```

The loop is state-driven. The router selects one next skill; it does not manufacture every artifact because a user mentioned a product.

## Run now

```bash
python3 scripts/product-systems/validate_pack.py
python3 -m unittest -v tests/product-systems/test_pack.py
python3 scripts/product-systems/run_eval_contracts.py
```

Read [INSTALL.md](INSTALL.md) for branch/ZIP installation and [HANDOFF_TO_OMP.md](HANDOFF_TO_OMP.md) for the exact agent instruction.

## Promotion status

`candidate`. Structural tests, deterministic contract tests, clean-install tests, checksums, and archive integrity are included. Live multi-model trigger/behavior runs remain a promotion gate because this environment did not expose an authorized model runner after the PageSpace review agent returned `402 out_of_credits`.

## Authority

- **GitHub:** code, skills, schemas, tests, ADRs, versioned contracts.
- **OMP/Shepherd/verifier:** candidate execution and exact retained-candidate verification.
- **Apply controller:** commit/merge or accepted-state mutation.
- **PageSpace:** source-rich research, architecture review, portfolio view.
- **Reverie:** approved atomic learnings only.

No fetched page, generated draft, worker, or skill may promote itself.
