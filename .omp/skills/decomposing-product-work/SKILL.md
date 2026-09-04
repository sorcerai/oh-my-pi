---
name: decomposing-product-work
description: Use when an accepted product specification must become executable issues, vertical slices, milestones, dependencies, or acceptance tests without losing intent.
---

# Decomposing Product Work

## Overview

Convert an accepted specification into risk-first, end-to-end slices that produce observable product behavior. Preserve traceability from source decision → requirement → work item → test/evidence.

Do not decompose an unaccepted or materially blocked PRD. Route it back to review instead of turning uncertainty into a backlog.

Read [risk-first slicing](references/risk-first-slicing.md) and use [the work-breakdown template](assets/work-breakdown.md).

## Inputs

- accepted product document and exact version/hash;
- approval/implementation authority receipt;
- relevant review findings and resolved patches;
- repository/system boundaries;
- delivery appetite and sequencing constraints;
- team/agent ownership model;
- required destination: GitHub, Linear, OMP Fleet, or another executor.

## Output contract

Create one `WorkBreakdown`:

```yaml
artifact_type: work-breakdown
schema_version: work-breakdown.v1
artifact_id: WORK-<document>-<version>
source_document: <id@version/hash>
status: proposed
implementation_authority: <receipt/ref>
vertical_slices: []
dependencies: []
risks: []
verification_plan: []
```

Each work item requires:

```text
work_id
outcome
prd_refs
risk_retired
in_scope
out_of_scope
dependencies
acceptance
instrumentation
rollback_or_recovery
owner
estimate/appetite class
proof_artifacts
```

Work items SHOULD be independently reviewable and, when safe, independently shippable or reversible.

## Workflow

1. **Verify acceptance.** Exact spec version and authority receipt must exist.
2. **Build traceability map.** Group requirements by user-visible outcome and shared risk—not file layer.
3. **Identify walking skeleton.** Smallest end-to-end path that proves contracts, integration, and observability without pretending the product is complete.
4. **Front-load existential risks.** Data access, permissions, model quality, migration, policy, latency, unit economics, or external integrations.
5. **Slice vertically.** Each slice spans enough UI/API/data/ops to prove one behavior. Technical subtasks may sit inside; they are not the primary plan.
6. **Define acceptance from the PRD.** Use deterministic tests where possible and explicit reviewer/metric evidence where judgment remains.
7. **Add instrumentation and recovery.** A slice that cannot be observed or safely reversed is incomplete.
8. **Order dependencies.** Distinguish hard prerequisite, sequencing preference, and parallel-safe work.
9. **Assign bounded ownership.** One accountable owner/agent per work item; shared contributors do not erase accountability.
10. **Check coverage.** Every in-scope requirement maps to at least one work item/test; every work item maps upstream.
11. **Create destination-ready payloads.** Keep titles concise; put full evidence and acceptance in the body.

### Recommended sequence

```text
contract + walking skeleton
→ highest uncertainty/risk spike
→ first complete user outcome
→ failure/recovery and permissions
→ rollout/instrumentation
→ scale/quality hardening
```

This is a default, not a ritual. Sequence by risk and dependency evidence.

## Verification

- exact accepted source document is named;
- no unresolved P0/P1 review blocker is buried in tasks;
- slices are user/outcome-oriented, not frontend/backend/database buckets;
- every requirement has downstream coverage;
- every work item has acceptance and proof artifacts;
- instrumentation and rollback/recovery are present where needed;
- dependencies are typed;
- ownership is singular and bounded;
- no implementation details contradict accepted product behavior.

## Common failures

| Failure | Correction |
|---|---|
| “Frontend / backend / database” as three stories | Create one vertical outcome with technical subtasks. |
| Convert headings into tickets | Decompose behavior and risk, not document layout. |
| Hide unanswered product decisions in engineering tasks | Route decision back to PRD/review authority. |
| Acceptance = “works” | Name observable test, event, artifact, or reviewer evidence. |
| Build easy polish before existential risk | Front-load the cheapest decisive risk slice. |
| One giant epic | Split by independent outcome/review/reversal boundary. |
| Orphan cleanup tasks | Link upstream requirement/risk or remove. |

## Example

Instead of separate “build OAuth UI,” “build OAuth API,” and “create token table,” create:

```text
WORK-AUTH-001 — A permitted pilot user can connect one supported provider, see success/failure state, and revoke access.
PRD refs: REQ-AUTH-001..006
Risk retired: provider contract + token lifecycle + permission UX
Acceptance: sandbox integration test, audit event, revoke verification, documented failure recovery
```
