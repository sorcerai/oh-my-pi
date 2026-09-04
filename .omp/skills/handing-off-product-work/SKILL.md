---
name: handing-off-product-work
description: Use when product work must transfer to OMP, a coding agent, prototyper, GitHub issue or PR, Linear, or another execution system with bounded context and explicit authority.
---

# Handing Off Product Work

## Overview

Translate accepted product intent into a destination-specific execution envelope. Preserve source/version traceability, scope, acceptance, and authority while removing irrelevant context.

A handoff is not a permission upgrade. The receiving agent gets only the actions explicitly granted.

Read [destination profiles](references/destination-profiles.md) and use [the handoff template](assets/handoff-template.md).

## Inputs

- accepted or explicitly authorized source artifact/version;
- work breakdown or bounded task;
- destination and executor identity;
- repository/project location;
- allowed reads/writes/tools;
- branch/PR/apply policy;
- verification commands and proof expectations;
- constraints, secrets policy, and stop conditions.

## Output contract

Create one `ExecutionHandoff`:

```yaml
artifact_type: execution-handoff
schema_version: execution-handoff.v1
artifact_id: HANDOFF-<project>-<sequence>
source_refs: []
destination: omp | github-issue | github-pr | linear | prototyper | research-agent
objective: <single bounded outcome>
scope: []
non_scope: []
authority: []
verification: []
proof_artifacts: []
stop_conditions: []
return_contract: []
```

Required body order:

1. objective and done definition;
2. canonical sources and exact versions;
3. scope/non-scope;
4. constraints and accepted decisions;
5. work items or requested mutation;
6. authority and forbidden actions;
7. verification and proof artifacts;
8. unresolved blockers/unknowns;
9. return contract.

## Workflow

1. **Bind accepted intent.** Name exact artifact IDs, versions, hashes, and authority receipt.
2. **Choose destination profile.** Do not send a 30-page PRD to a prototyper or a screenshot brief to a repository mutator.
3. **Compress context.** Keep decisions, constraints, requirement/work IDs, interfaces, examples that demonstrate shape, and source pointers.
4. **State one objective.** Multiple independently reversible outcomes become separate handoffs or work items.
5. **Define scope and non-scope.** Include paths/components when known; never invent repository layout.
6. **State authority positively.** Reads, candidate edits, branch creation, PR creation, comments, or external actions are separate capabilities.
7. **Name forbidden actions.** Direct-to-main, merge, publication, external sends, deletion, payment, credential exposure, or acceptance claims require explicit authority.
8. **Bind verification to candidate.** Commands, checks, screenshots/traces, requirement coverage, and expected outputs.
9. **Specify stop conditions.** Missing source, collision, failing critical test, ambiguous authority, policy block, or incompatible contract.
10. **Define return envelope.** Changed files, branch/PR, tests, deviations, blockers, receipts, and recommendation.

### OMP authority profile

Default OMP handoff:

- MAY inspect sources and create a feature branch;
- MAY produce retained candidate changes and open/update a PR;
- MUST run named verification against the exact candidate;
- NEVER push directly to main or merge;
- NEVER treat worker confidence as acceptance;
- apply controller or explicit human authority retains commit/merge/accepted-state mutation.

## Verification

- exact source artifact/version is present;
- destination profile matches the work;
- objective is singular and testable;
- scope/non-scope prevents adjacent work;
- authority lists allowed and forbidden actions;
- external content cannot expand authority;
- verification is executable and candidate-bound;
- secrets/private data handling is explicit when relevant;
- return contract exposes deviations and blockers.

## Common failures

| Failure | Correction |
|---|---|
| Paste entire conversation | Send bounded artifacts and stable references. |
| “Implement this” with no source version | Bind exact accepted document/work IDs. |
| Assume PR creation means merge authority | State capabilities separately. |
| Verification = “review your work” | Name commands, artifacts, and pass conditions. |
| Prototyper receives production constraints only | Include product behavior, states, and visual/interaction acceptance. |
| Coding agent receives marketing narrative | Keep requirement/work contracts; link optional background. |
| Missing decision becomes agent freedom | Stop and route to named authority. |

## Example

```yaml
objective: Implement WORK-DASH-003 on a feature branch and open a draft PR.
source_refs: [PRD-DASH-004@v3, WORK-DASH-003@v1]
authority:
  - read repository and named sources
  - create feature branch and retained candidate edits
  - open or update draft PR
  - never merge or push directly to main
verification:
  - pnpm test
  - pnpm typecheck
  - requirement trace check for REQ-DASH-014..018
stop_conditions:
  - source version mismatch
  - existing incompatible migration
  - critical test cannot run
```
