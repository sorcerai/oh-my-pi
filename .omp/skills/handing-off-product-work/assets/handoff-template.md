# Execution Handoff Template

```yaml
artifact_type: execution-handoff
schema_version: execution-handoff.v1
artifact_id: HANDOFF-<project>-<sequence>
status: proposed
created_at: <ISO-8601>
created_by: <identity>
source_refs: []
decision_refs: []
destination: <profile>
executor: <identity/runtime>
objective: <single bounded outcome>
scope: []
non_scope: []
authority:
  allowed: []
  forbidden: []
verification: []
proof_artifacts: []
stop_conditions: []
return_contract: []
```

# Objective and done definition

# Canonical sources

| Ref | Version/hash | Why needed |
|---|---|---|

# Scope

# Non-scope

# Constraints and accepted decisions

# Work requested

# Authority

## Allowed

## Forbidden

# Verification

| Check | Command/method | Pass condition | Proof artifact |
|---|---|---|---|

# Blockers and stop conditions

# Return contract

- branch/PR or destination object;
- changed-file/object inventory;
- verification results;
- deviations from accepted contract;
- unresolved blockers/unknowns;
- receipts and hashes;
- recommendation: REJECT / REWORK / READY_FOR_REVIEW.
