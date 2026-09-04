# Product Review Rubric

Each gate is `PASS`, `FAIL`, or `NOT_APPLICABLE`. A `FAIL` includes evidence and required change.

| Gate | Pass condition | Default severity when absent |
|---|---|---|
| Problem evidence | Problem and affected user/moment supported or explicitly experimental. | P1 |
| Business value | Outcome/economics and current alternative are credible enough for appetite. | P1/P2 |
| Goals/non-goals | Success and exclusions are observable and non-contradictory. | P1 |
| Requirement quality | Stable IDs, atomic behavior, observable acceptance. | P1 |
| Experience states | Relevant empty/failure/permission/migration/recovery states covered. | P1/P2 |
| Data | Metric definition, denominator, cohort, window, instrumentation, decision rule. | P1 |
| Technical feasibility | Critical dependencies and quality attributes bounded. | P1 |
| Rollout/rollback | Cohort, gates, monitoring, abort, and recovery defined. | P1 |
| Trust/safety/policy | Applicable obligations, abuse, access, privacy, retention, security covered. | P0/P1 |
| Operations | Support, incident, moderation, or manual load bounded. | P1/P2 |
| Traceability | Requirements link to sources/decisions and downstream work can retain IDs. | P1/P2 |
| Authority | Acceptance owner and unresolved decisions explicit. | P1 |

## Lens activation

Always: strategy, user/experience, requirement quality, data, rollout.  
Activate engineering depth when implementation is imminent.  
Activate policy/security/operations when data, money, identity, regulated claims, user-generated content, irreversible actions, or material support burden exists.

## Reviewer discipline

- Review against the stated appetite and goals, not the reviewer’s preferred product.
- One finding per independent failure.
- Merge repeated symptoms under the root defect.
- Name the smallest correction that satisfies the gate.
- Preserve good constraints explicitly so a rewrite does not remove them.
