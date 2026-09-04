---
name: shaping-product-bets
description: Use when an idea is broad, solution-first, under-bounded, or missing a clear problem, appetite, no-gos, risks, and success condition.
---

# Shaping Product Bets

## Overview

Turn a raw idea into a bounded bet that deserves specification. Shape the problem and appetite before generating requirements. A feature list without a problem, budget, and kill signal is not a plan; it is a wishlist wearing Jira perfume.

Use [the shaping rubric](references/shaping-rubric.md) when the idea has several plausible paths.

## Inputs

- raw idea, request, or opportunity;
- `ProductContextPacket` when existing evidence matters;
- target user/customer and current behavior;
- business model or economic objective;
- appetite: time, money, complexity, or reversibility budget;
- hard constraints and authority;
- evidence quality and major unknowns.

When grounding is absent but source-dependent facts can change the shape, route back rather than invent them.

## Output contract

Create one `ProductBet` using [the product-bet template](assets/product-bet.md).

Required fields:

```yaml
problem
who_and_when
current_alternative
why_now
demand_evidence
business_value
appetite
solution_shape
serious_alternatives
rabbit_holes
no_gos
risks
success_signal
kill_criteria
open_questions
source_refs
```

The bet ends with `shape_verdict: READY_FOR_SPEC | NEEDS_EVIDENCE | REJECT`.

## Workflow

1. **Restate the problem without the proposed solution.** If that cannot be done, the idea is still solution-first.
2. **Name who experiences it and when.** “Users” is not a segment; “businesses” is not a moment.
3. **Describe the current alternative.** Manual behavior, competitor, spreadsheet, inaction, or workaround.
4. **Test why now.** Evidence, strategic fit, new capability, market change, or active pain—not enthusiasm.
5. **Set appetite.** Bound the bet by spend, time, complexity, risk, and reversibility. Do not estimate an unlimited design.
6. **Generate serious paths.** Use two to four only when a real decision exists. Include “do nothing/manual” when credible.
7. **Choose a solution shape.** Name the core mechanism and rough boundaries, not implementation detail.
8. **Hunt rabbit holes.** Data acquisition, permissions, cold start, compliance, integration, migration, moderation, unit economics, support, or operational load.
9. **Lock no-gos.** Explicitly exclude attractive adjacent features.
10. **Define success and death.** One leading signal, one economic/outcome signal, and observable kill criteria.
11. **Issue verdict.** Missing decisive evidence routes to grounding or a bounded experiment; weak economics routes to reject.

### Option matrix

Use only for genuine forks:

| Path | Core move | Expected ROI | Speed | Risk | Reversibility | Evidence confidence |
|---|---|---:|---:|---:|---:|---:|

Pick one path and state why it dominates under the appetite. Do not produce four “options” that are the same product with different adjectives.

## Verification

- problem can be stated without the solution;
- target user and triggering moment are concrete;
- evidence and inference are separated;
- appetite bounds the design;
- alternatives are serious;
- rabbit holes and no-gos are explicit;
- success and kill criteria are observable;
- economic value is not replaced by engagement vanity;
- verdict matches evidence quality.

## Common failures

| Failure | Correction |
|---|---|
| Start with feature requirements | Return to problem, user, alternative, appetite. |
| “AI-powered” as solution shape | Name the changed behavior and mechanism. |
| Infinite scope disguised as platform | Lock the first bounded wedge and no-gos. |
| Fake option matrix | Include materially different paths or omit it. |
| Success = ship | Define behavior and economic/outcome change. |
| Risk list with no design consequence | Tie each critical risk to a test, boundary, or kill rule. |
| Unknown demand becomes assumption | Route to cheapest decisive evidence. |

## Example

Raw idea: “Build a directory for every local service.”

A valid shape may narrow to one repeated, urgent, high-ticket query family; cap the first build at a fixed number of locations/providers; exclude marketplace payments and full CRM; test qualified lead yield; kill if verified supply or conversion economics miss the threshold. The exact thresholds come from evidence and appetite, not the model’s imagination.
