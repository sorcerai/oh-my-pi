# Agent Skill Contract

## Put the behavior in the right layer

| Need | Correct layer |
|---|---|
| Reusable judgment or technique | skill |
| Always-on identity/authority invariant | system prompt/runtime policy |
| Repository-specific commands and conventions | repository instructions |
| Deterministic validation/transformation | script/code |
| Tool selection and wire syntax | tool documentation |
| One-time desired output | task prompt/artifact |

## Frontmatter

Required:

```yaml
---
name: lowercase-hyphenated
# Starts with “Use when”; describes triggers/symptoms only.
description: Use when ...
---
```

The description is retrieval surface. Include user-language synonyms and concrete symptoms, but do not summarize the procedure.

## Progressive disclosure

- Core skill: decisions the model must make every time.
- Reference: detailed domain material loaded only when needed.
- Asset: exact output/template copied or adapted.
- Script: stable deterministic operation.

## RED case types

- **Trigger:** skill should or should not load.
- **Shape:** output misses required slots/order.
- **Discipline:** agent skips a rule under pressure.
- **Technique:** agent applies method incorrectly.
- **Authority:** agent performs or claims an unauthorized action.
- **Regression:** an edit fixes one case and breaks another.

## Guidance form

- Wrong output shape → positive recipe/contract.
- Missing required field → structural slot.
- Conditional behavior → observable condition.
- Rule skipped under pressure → prohibition + rationalization counters.

Do not use a wall of prohibitions to shape an output; it invites negotiation and still leaves the desired artifact undefined.

## Promotion evidence

A promoted skill has:

- structural validation;
- positive and negative trigger evidence;
- held-out behavior evidence;
- critical authority cases;
- repeated-run variance where stochastic behavior matters;
- source/version record;
- rollback path;
- human or configured approval.
