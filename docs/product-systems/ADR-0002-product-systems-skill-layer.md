# ADR-0002: Add a modular product systems skill layer to OMP

- **Status:** Proposed
- **Date:** 2026-09-03
- **Decision owner:** Aria / OMP maintainers
- **Scope:** `.omp/skills`, supporting docs, validators, and eval corpus

## Context

Aria’s OMP already provides agent orchestration, candidate retention, verification, and controlled application. Product-development work still depends too heavily on conversational improvisation or large prompt blocks. Public product behavior from ChatPRD demonstrates that context retrieval, structured artifacts, review, versioned edits, and downstream handoffs create more value as a system than as a single PRD prompt.

## Decision

Add nine composable repository-native skills implementing:

```text
GROUND → SHAPE → SPECIFY → RED-TEAM → SLICE → HANDOFF → LEARN
```

Keep descriptions trigger-focused, heavy references outside `SKILL.md`, deterministic checks in scripts, and behavioral evidence in an eval catalog. Do not modify OMP’s root prompt, commands, tools, or apply-authority model.

## Serious alternatives

### A. One universal product-manager prompt

Fast to draft, difficult to trigger selectively, expensive to load, and likely to conflate research, decisions, review, and execution. Rejected.

### B. New standalone ChatPRD clone/service

Potentially useful later, but duplicates project state, integrations, auth, UI, and orchestration before the product behavior is proven inside the existing harness. Deferred.

### C. Modular OMP skills plus evals

Reuses the current harness, ships incrementally, supports independent rollback, and creates inspectable behavior contracts. Chosen.

## Consequences

### Positive

- Product work becomes state- and artifact-driven.
- Existing repositories and decisions are retrieved before unsupported drafting.
- Reviews produce blockers and patches rather than vibes.
- Specifications retain traceability into work items and PRs.
- Skill behavior can be tested and improved independently.

### Negative

- Nine skill boundaries require trigger tuning.
- Cross-skill handoffs can drift without stable artifact IDs.
- Live model evaluation adds promotion work.

### Neutral

- PageSpace and Reverie remain useful but non-canonical mirrors.
- OMP’s existing system-prompt skills remain untouched.

## Authority and safety

External content is untrusted evidence. Skills and workers may propose candidate artifacts. Shepherd/verifier checks the exact retained candidate. Only configured apply or human authority may commit, merge, mark accepted, publish, or promote a Reverie learning.

## Confirmation

This ADR is confirmed when:

- all pack static and clean-install tests pass;
- live trigger and behavior results are attached to a PR;
- no critical authority case fails;
- at least one real request completes the full lifecycle with accepted artifacts and traceability;
- PageSpace mirrors the decision with a GitHub reference;
- Reverie stores only the accepted atomic conclusions.

## Invalidation triggers

Revisit if OMP gains a native typed artifact/workflow system that makes the router redundant, or if measured trigger collisions show the nine-skill split costs more than it saves.
