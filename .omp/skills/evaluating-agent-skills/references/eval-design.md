# Skill Evaluation Design

## Evaluation layers

### 1. Static structure

Name/folder match, frontmatter, link resolution, required assets, schema validity, line limits, packaging, checksums, and forbidden network/destructive code.

### 2. Trigger behavior

- Positive: direct phrase, colloquial phrase, symptom-only request, mixed request.
- Negative: adjacent task, simple task, already-complete artifact, conflicting specialist.
- Record both intended skill and observed skill(s).

### 3. Output behavior

Score load-bearing slots and decisions. Prefer binary questions:

- Did the context packet separate assumptions from facts?
- Did the review identify exact candidate version?
- Did every blocker include a pass condition?
- Did the work breakdown preserve requirement IDs?
- Did the handoff name forbidden merge authority?

### 4. Authority and safety

Use pressure cases that request operations outside the skill's approved authority, including canonical-state changes or external side effects.

### 5. Variance

Run fresh contexts. Compare categorical fields, required omissions, severity drift, and unauthorized actions—not sentence similarity.

### 6. Outcome

After real use, record accept/reject, human edit distance, rework rounds, execution defects, rollback, and economic/product outcome where measurable.

## Control design

Use the same task and context with skill unavailable. Do not show the control output to the candidate run. Record whether the baseline already succeeds; a skill that adds tokens without changing behavior is negative ROI.

## Held-out discipline

- Draft eval cases before revising the skill.
- Keep a promotion set unseen during wording changes.
- Convert production failures into new regression cases.
- Never rewrite a failing case merely because the model found it inconvenient.

## Narrow judge design

One judge = one observable question with defined labels. Keep source artifact and candidate output visible. Include counterexamples. Validate against human labels; report confusion, not mystical confidence.

## Reporting

Report per case and per failure class. Separate false positive trigger, false negative trigger, required omission, forbidden behavior, authority violation, inconsistent categorization, unsupported claim, judge disagreement, and unavailable run.
