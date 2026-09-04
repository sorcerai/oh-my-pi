---
name: red-teaming-prds
description: Use when a PRD or product plan needs an executive, CPO, engineering, UX, data, risk, or launch-readiness review before approval or implementation.
---

# Red-Teaming PRDs

## Overview

Review a product document as an adversarial but constructive decision gate. Find the few defects that can invalidate value, scope, implementation, measurement, safety, or launch—not every sentence that could be prettier.

Review is read-only by default. Return exact patch proposals; never silently replace the author’s document.

Use [the review rubric](references/review-rubric.md) and [report template](assets/review-report.md).

## Inputs

- product document with artifact ID/version;
- upstream bet/context/decision references;
- intended approval or implementation gate;
- reviewer lenses requested;
- applicable appetite, policy, security, and operational constraints;
- prior review and change set when re-reviewing.

If the document version is ambiguous, stop and identify the exact candidate before reviewing.

## Output contract

Return one `ProductReview`:

```yaml
artifact_type: product-review
schema_version: product-review.v1
artifact_id: REV-<document>-<round>
reviewed_artifact: <id@version/hash>
verdict: PASS | PASS_WITH_CHANGES | BLOCKED
blocking_findings: []
nonblocking_findings: []
patches: []
assumptions: []
unknowns: []
review_lenses: []
```

Each finding requires:

```text
finding_id
severity: P0 | P1 | P2 | NOTE
lens
location: section/requirement ID
claim
why_it_matters
supporting_evidence
required_change_or_decision
owner_or_authority
verification
```

Severity:

- `P0` — unsafe, unlawful, corrupting, irreversible, or invalidates the product premise;
- `P1` — blocks implementation/launch or makes success unmeasurable;
- `P2` — meaningful improvement but bounded work may proceed;
- `NOTE` — clarification or optional improvement.

## Workflow

1. **Bind the candidate.** Record exact ID/version/hash and review purpose.
2. **Reconstruct intent.** Problem, user, outcome, appetite, non-goals, and accepted decisions.
3. **Run strategy lens.** Is the problem evidenced, segment concrete, alternative understood, value/economics plausible, and scope consistent with appetite?
4. **Run experience lens.** Do flows and relevant states support the intended behavior without contradictions or inaccessible paths?
5. **Run engineering lens.** Are requirements atomic/testable; dependencies, migration, failure, performance, security, and rollback decision-ready?
6. **Run data lens.** Are baselines, denominators, events, cohorts, windows, and decision rules sufficient to learn?
7. **Run trust/operations lens when applicable.** Privacy, compliance, abuse, permissions, support, retention, and incident recovery.
8. **Trace requirements.** Detect orphan requirements, unsupported claims, and upstream decisions lost downstream.
9. **Rank only decision-changing findings.** Merge duplicates; distinguish blocker from preference.
10. **Propose surgical patches.** Section/ID, operation, replacement/addition, rationale, and source.
11. **Issue verdict.** Any unresolved P0/P1 => `BLOCKED`; only P2/NOTE => `PASS_WITH_CHANGES`; no required change => `PASS`.

## Verification

- reviewed artifact identity is exact;
- verdict follows unresolved severity, not reviewer mood;
- every blocker names evidence and pass condition;
- preferences are not inflated into blockers;
- unknowns are separated from defects;
- patches preserve unaffected sections and stable IDs;
- review does not claim approval authority;
- no arbitrary aggregate helpfulness/quality score replaces binary gates.

## Common failures

| Failure | Correction |
|---|---|
| Rewrite the PRD and call it review | Return findings and exact patches. |
| 40 low-value comments | Rank the few decision-changing failures. |
| “Needs more detail” | Name missing decision, impact, owner, and verification. |
| Block on personal preference | Tie severity to goal, constraint, risk, or acceptance. |
| Praise sandwich | State verdict first; keep praise only when it protects a good decision. |
| Treat missing baseline as zero | Mark unknown and define evidence plan. |
| Self-approve after fixing | Re-review exact revision; authority remains external. |

## Example

Finding:

```text
REV-F-003 | P1 | Data
Location: Goals and success metrics
Claim: “Increase activation by 20%” has no activation definition, denominator, baseline source, cohort, or decision window.
Why it matters: Implementation can ship while every team reports a different outcome.
Required change: Define event sequence, eligible denominator, baseline source, pilot cohort, measurement window, and go/no-go rule.
Verification: Data owner confirms query on staging/pilot data before rollout gate.
```
