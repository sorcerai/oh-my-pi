# Product Route Template

```yaml
artifact_type: product-route
schema_version: product-route.v1
artifact_id: ROUTE-<project>-<date>-<sequence>
project_id: <stable id>
current_state: <state>
next_artifact: <artifact>
next_skill: <skill or null>
why_now: <decision-changing reason>
source_refs:
  - <stable source/version>
blockers: []
authority_required: <role or null>
stop_condition: <observable condition>
after:
  - when: <condition>
    skill: <possible next skill>
```

## Route note

Keep `after` informational. The current run owns only `next_skill` unless the user explicitly authorizes a multi-stage execution and each transition passes its gate.
