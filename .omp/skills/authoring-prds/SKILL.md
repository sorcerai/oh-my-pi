---
name: authoring-prds
description: Use when creating or materially revising a PRD, one-pager, product specification, feature brief, requirements document, technical spec, GTM brief, or user-story package.
---

# Authoring PRDs

## Overview

Create a durable product contract from a shaped bet and grounded context. Choose the smallest artifact profile that can align decision-makers and executors. Preserve uncertainty, stable IDs, source lineage, and version history.

For existing documents, edit surgically. Do not regenerate unaffected sections because a model enjoys fresh prose.

Read [artifact profiles](references/artifact-profiles.md) before selecting the document shape and [requirements guidance](references/requirements-writing.md) before writing requirement IDs.

## Inputs

- accepted or proposed `ProductBet`;
- `ProductContextPacket` and source references;
- requested artifact profile;
- current document/version when revising;
- audience and decision authority;
- technical, policy, budget, and delivery constraints;
- intended downstream destination.

Missing metrics or legal/technical facts stay in `unknowns`; never fabricate a baseline to make the PRD look mature.

## Output contract

Use [the PRD template](assets/prd-template.md) or the corresponding artifact profile.

Every durable product document includes:

```yaml
artifact_type: product-document
schema_version: product-document.v1
document_profile: prd | one-pager | feature-brief | user-story-package | technical-spec | gtm-brief
artifact_id: <stable id>
version: <integer>
status: draft | proposed | blocked | accepted | superseded
source_refs: []
decision_refs: []
assumptions: []
unknowns: []
change_summary: []
```

Full PRDs require:

- problem and evidence;
- target users/jobs and current alternative;
- goals, success metrics, and non-goals;
- solution overview and key flows/states;
- scoped requirements with stable IDs;
- edge, failure, permission, empty, loading, migration, and abuse states as applicable;
- data/instrumentation;
- rollout, rollback, and support implications;
- risks, dependencies, open questions, and decision log;
- acceptance/readiness gate.

## Workflow

1. **Select the artifact profile.** One-pager for a decision; full PRD for cross-functional implementation; technical spec for implementation mechanics after product behavior is settled.
2. **Bind sources.** Carry the bet/context IDs and exact versions. State when evidence is partial.
3. **Write the narrative spine.** Problem → user/moment → current alternative → desired outcome → bounded solution.
4. **Lock goals and non-goals.** Every goal gets a measurement method or explicit evidence plan.
5. **Model the experience.** Primary flow plus states that change requirements: first use, repeat use, empty, loading, failure, permissions, limits, migration, abuse, recovery.
6. **Write atomic requirements.** One testable behavior per ID; include actor, condition, behavior, observable result, and priority.
7. **Add quality attributes only when measurable.** Latency, availability, accessibility, privacy, security, cost, and scale need thresholds or test methods.
8. **Define instrumentation.** Event/metric owner, baseline availability, denominator, window, and decision use.
9. **Plan rollout and rollback.** Cohort, gate, monitoring, abort signal, migration, support, and recovery.
10. **Preserve uncertainty.** Separate assumption, unknown, decision, and blocked question.
11. **For revisions, emit a change set.** Name changed sections/IDs, reason, source, and compatibility impact; leave untouched content untouched.

### Requirement shape

```text
REQ-<area>-<nnn>
Actor + condition → required behavior → observable result.
Acceptance: deterministic check, event, or reviewer evidence.
Source: BET/CTX/decision reference.
```

## Verification

- document profile matches the decision/work need;
- every material claim traces to source, decision, inference, or assumption;
- requirement IDs are unique, atomic, and testable;
- non-goals prevent obvious scope creep;
- edge/failure states relevant to the product are covered;
- metrics include denominator and window where applicable;
- rollout has abort and rollback logic;
- revisions preserve untouched sections and IDs;
- acceptance status is not self-declared.

## Common failures

| Failure | Correction |
|---|---|
| Turn sparse evidence into confident market facts | Preserve `unknowns` and evidence plan. |
| Copy the bet verbatim into every section | Translate it into requirements and decisions. |
| User stories without behavior contracts | Add conditions, result, and acceptance evidence. |
| Mix product requirement with implementation choice | Separate behavior from technical design unless constrained. |
| Add every imaginable edge case | Include states that change risk, scope, or acceptance. |
| Full-document rewrite for one change | Emit section/ID patches and change summary. |
| “Launch” with no rollback | Add cohort, gates, abort signal, and recovery. |

## Example

Bad requirement: “The dashboard should be fast and intuitive.”

Better:

```text
REQ-DASH-014 — When a user loads a saved dashboard containing up to 20 supported widgets, the system must render the first usable view within the approved p95 threshold measured by `dashboard_first_usable_ms` for the rollout cohort.
Acceptance: threshold and cohort are defined before implementation; telemetry is present in staging and pilot.
```

The skill does not invent the threshold. It makes the missing decision impossible to hide.
