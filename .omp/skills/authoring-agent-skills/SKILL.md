---
name: authoring-agent-skills
description: Use when creating, editing, splitting, packaging, or versioning an OMP or Agent Skills folder and the behavior should be reusable across projects.
---

# Authoring Agent Skills

## Overview

Create a reusable skill only after defining a repeatable behavior and observing a baseline failure. Skills are task-specific, discoverable instruction assets—not dumping grounds for project policy, API documentation, or one-off prompts.

**No new or materially changed skill without a failing test or pressure case first.** Static lint alone does not satisfy the test.

Read [the skill contract](references/skill-contract.md) and start from [the skill template](assets/SKILL.template.md).

## Inputs

- repeated task or failure pattern;
- target runtime and skill search path;
- real input/output examples;
- no-skill baseline behavior;
- authority and tool constraints;
- existing skills with possible overlap;
- expected trigger phrases and negative cases;
- deterministic operations suitable for scripts.

Do not copy private prompts or external skill bundles without provenance, permission, and security review.

## Output contract

Create one skill directory:

```text
<skill-name>/
  SKILL.md                 required
  assets/                  copyable templates only when useful
  references/              heavy guidance only when useful
  scripts/                 deterministic reusable operations only
  tests/ or evals/         when runtime/package convention supports it
```

Also return a `SkillChangeRecord`:

```yaml
skill_name: <lowercase-hyphenated>
change_type: create | revise | split | merge | retire
trigger_contract: <observable use conditions>
baseline_failures: []
files: []
eval_cases: []
static_validation: []
behavioral_validation: []
authority_effect: none | narrowed | expanded
promotion_status: candidate | pilot | promoted | rejected
```

## Workflow

1. **Classify the candidate.** Reusable judgment/technique/pattern? Skill. Project-specific rule? Repository instructions. Mechanical invariant? Validator/code. One-off output? Prompt/artifact.
2. **Search for overlap.** Read existing descriptions and bodies. Prefer revising or splitting a skill over synonyms that collide.
3. **Write RED cases first.** At least one realistic positive task, one negative trigger case, and one pressure/authority case when applicable.
4. **Run or record the no-skill baseline.** Capture exact omission, wrong shape, rationalization, or authority failure. If no failure appears, do not invent a skill.
5. **Define the output shape.** Required slots and order beat a long prohibition list when the failure is wrong-shaped output.
6. **Write trigger-only frontmatter.** `name` matches folder; `description` starts `Use when...`, describes symptoms/situations, and does not summarize the workflow.
7. **Write minimal `SKILL.md`.** Overview, inputs, output contract, workflow, verification, common failures, one excellent example.
8. **Apply progressive disclosure.** Move heavy reference (>100 lines), reusable tools, and copyable templates out of the core file.
9. **Add deterministic scripts only for deterministic work.** Metadata, links, schemas, formatting, packaging—not subjective product judgment.
10. **Run GREEN cases.** Same tasks with the skill present; verify required behavior and no new authority expansion.
11. **Refactor against failures.** Tighten recipe, conditions, or rationalization counters; rerun held-out cases.
12. **Package and mark status.** Candidate until trigger and behavior evidence supports promotion.

### Description test

Bad:

```yaml
description: Use for PRDs; retrieves sources, asks questions, writes sections, reviews, and exports tickets.
```

The model may execute the summary and skip the body.

Good:

```yaml
description: Use when creating or materially revising a product requirements document from a bounded product bet and source-backed context.
```

## Verification

- no-skill baseline failed for the intended behavior;
- name is lowercase and hyphenated;
- description expresses when, not the internal workflow;
- core file remains decision-dense and references resolve;
- project-specific content is not disguised as reusable guidance;
- deterministic checks and behavioral checks are separated;
- positive, negative, and authority cases exist;
- exact skill version/files are recorded;
- authority is unchanged or explicitly reviewed;
- promotion status reflects evidence.

## Common failures

| Failure | Correction |
|---|---|
| Write skill before observing failure | Delete/rewrite from RED cases. |
| Giant `SKILL.md` with corpus and templates | Move heavy material to references/assets. |
| Description contains mini-workflow | Keep only trigger conditions. |
| Create a skill for a regex-enforceable invariant | Put it in a validator. |
| Duplicate an existing skill with new vocabulary | Revise, split, or improve discovery. |
| Static validator declared “quality passed” | Run behavior and trigger cases. |
| Add broad tool/write authority | Narrow it and require explicit review. |
| Batch-create many untested skills | Promote independently from per-skill evidence. |

## Example

Repeated failure: agents convert accepted specs into frontend/backend/database ticket piles. The RED case shows layer-based decomposition. The new skill defines vertical-slice output slots and traceability. The GREEN case must produce end-to-end outcomes on a held-out spec—not merely contain the phrase “vertical slice.”
