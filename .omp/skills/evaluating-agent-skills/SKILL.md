---
name: evaluating-agent-skills
description: Use when a skill may trigger incorrectly, produce inconsistent outputs, ignore constraints, regress after edits, or needs evidence before promotion.
---

# Evaluating Agent Skills

## Overview

Measure whether a skill loads at the right time and changes behavior in the intended way without expanding authority. Structure checks are necessary; they are not evidence that the model will comply.

Use [the evaluation design](references/eval-design.md) and [the eval case schema](assets/eval-cases.schema.json).

## Inputs

- exact skill directory/version/hash;
- intended trigger contract;
- no-skill baseline cases and outputs;
- positive and negative trigger cases;
- behavior/authority requirements;
- target models/runtimes;
- human labels or decision owner;
- prior failures and production examples.

## Output contract

Create one `SkillEvalReport`:

```yaml
artifact_type: skill-eval
schema_version: skill-eval.v1
skill: <name@version/hash>
runtime_matrix: []
control_results: []
trigger_results: []
behavior_results: []
authority_results: []
variance_results: []
regressions: []
limitations: []
verdict: REJECT | REWORK | PILOT | PROMOTE
```

Every evaluated requirement is binary or categorical with evidence. Do not hide a critical failure inside an aggregate score.

## Workflow

1. **Bind the candidate.** Record exact skill files, runtime, provider/model/version, tools, and context.
2. **Define a no-skill control.** Run the same realistic task without the candidate skill. If the desired behavior already occurs consistently, the skill may be unnecessary.
3. **Test trigger precision.** Positive cases should load; near-neighbor negative cases should not. Include user phrasing, synonyms, and ambiguous mixed requests.
4. **Test behavior.** Required output slots, decisions, source handling, and stop conditions on held-out inputs.
5. **Test authority.** Use pressure cases for operations outside the skill's approved authority.
6. **Repeat stochastic cases.** Fresh contexts; default three or more repetitions for ambiguous/high-risk cases. Record variance by binary field and failure type.
7. **Use deterministic checks first.** Frontmatter, naming, links, schemas, exact markers, and forbidden actions.
8. **Use narrow judges for judgment.** One question per judge—e.g., “Does every blocker include a pass condition?” Validate judges against human labels.
9. **Read failures manually.** Marker counts can match quoted counterexamples or miss semantically wrong output.
10. **Compare control vs candidate.** Improvement must be attributable enough to justify added context and trigger collision risk.
11. **Issue per-skill verdict.** Critical authority failure => `REJECT`; correctable pattern => `REWORK`; incomplete real-world evidence => `PILOT`; demonstrated trigger/behavior/authority stability => `PROMOTE` with approval.

### Default report table

| Case | Runtime | Rep | Trigger expected/observed | Required behavior | Forbidden behavior | Human label | Notes |
|---|---|---:|---|---|---|---|---|

### Promotion floor

Treat these as project defaults, not universal science:

- structural contracts: 100% pass;
- critical authority violations: 0;
- required binary gates: all pass on promotion set;
- negative trigger cases: no critical false positives;
- positive trigger coverage: every intended skill/use class observed;
- held-out real task: accepted with bounded rework;
- limitations and runtime coverage disclosed.

## Verification

- control and candidate use the same task/context except skill availability;
- candidate version and runtime metadata are exact;
- trigger and behavior are scored separately;
- negative trigger and authority pressure cases exist;
- repeated runs use fresh contexts;
- deterministic and judge-based results are distinguished;
- every automated judge has a human-labeled sanity set or is marked unvalidated;
- manual review checks semantic failures and quoted markers;
- verdict follows critical gates and evidence limits;
- promotion requires configured authority.

## Common failures

| Failure | Correction |
|---|---|
| Lint passes, therefore skill works | Run control, trigger, behavior, and authority cases. |
| Only positive trigger cases | Add near-neighbor negatives and mixed requests. |
| One run per case | Repeat stochastic/ambiguous cases in fresh context. |
| Single “helpfulness” score | Use narrow binary/categorical gates. |
| Judge validates itself | Compare judge labels with human labels. |
| Marker match without reading output | Manually inspect matches and semantic correctness. |
| Change eval cases after seeing output | Keep held-out set; add failures as new regression cases. |
| Promote the whole pack together | Verdict and rollback per skill. |

## Example

A PRD review skill always emits “verdict” and “severity,” so static markers pass. Manual inspection shows every finding is `P1` and no pass condition exists. The behavior gate fails despite perfect structure. Add a binary judge for pass-condition presence, a preference-vs-blocker pressure case, and a held-out document before revising the skill.
