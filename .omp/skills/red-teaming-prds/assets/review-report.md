# Product Review Template

```yaml
artifact_type: product-review
schema_version: product-review.v1
artifact_id: REV-<document>-<round>
reviewed_artifact: <artifact id@version/hash>
review_purpose: <decision gate>
verdict: PASS | PASS_WITH_CHANGES | BLOCKED
review_lenses: []
created_at: <ISO-8601>
created_by: <identity>
blocking_findings: []
nonblocking_findings: []
patches: []
assumptions: []
unknowns: []
```

# Verdict

## What is strong and must be preserved

## Blocking findings

| ID | Severity | Lens | Location | Claim | Why it matters | Required change/decision | Owner | Verification |
|---|---|---|---|---|---|---|---|---|

## Non-blocking findings

## Patch proposals

| Patch ID | Finding | Operation | Section/ID | Proposed content | Source/rationale |
|---|---|---|---|---|---|

## Unresolved authority and evidence

## Re-review gate
