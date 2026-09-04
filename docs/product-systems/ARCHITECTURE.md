# Product Systems Skill Architecture

## Decision

Add a modular, repository-native product judgment layer to OMP. Do not alter OMP’s root system prompt, tool surface, worker authority, or apply controller.

## Lifecycle

```text
raw request
  ↓
routing-product-work
  ↓
grounding-product-context (when existing evidence matters)
  ↓
shaping-product-bets (when the bet is not bounded)
  ↓
authoring-prds
  ↓
red-teaming-prds
  ↓
decomposing-product-work
  ↓
handing-off-product-work
  ↓
OMP / GitHub / Linear / prototyper candidate work
  ↓
verification + human/apply authority
  ↓
approved atomic learning
```

`authoring-agent-skills` and `evaluating-agent-skills` operate on the skill layer itself. They are not automatic final stages of every product request.

## Artifact state model

| State | Canonical artifact | Allowed next states |
|---|---|---|
| `unscoped` | raw request | `grounded`, `shaped`, `stopped` |
| `grounded` | `ProductContextPacket` | `shaped`, `specified`, `stopped` |
| `shaped` | `ProductBet` | `specified`, `stopped` |
| `specified` | `ProductDocument` | `reviewed`, `revised` |
| `reviewed` | `ProductReview` | `revised`, `accepted`, `stopped` |
| `accepted` | accepted document + authority receipt | `decomposed`, `handed_off` |
| `decomposed` | `WorkBreakdown` | `handed_off`, `revised` |
| `handed_off` | `ExecutionHandoff` | `candidate`, `blocked` |
| `candidate` | branch/PR/prototype + verification evidence | `accepted`, `rejected`, `rework` |

A model may propose a transition. Only configured authority may mark `accepted` or mutate canonical state.

## Common artifact envelope

Every durable artifact SHOULD carry:

```yaml
artifact_type: product-context | product-bet | product-document | product-review | work-breakdown | execution-handoff | skill-eval
schema_version: <contract version>
artifact_id: <stable id>
version: <integer or semantic version>
status: draft | proposed | blocked | accepted | superseded
project_id: <stable project id>
source_refs: []
decision_refs: []
assumptions: []
unknowns: []
created_at: <ISO-8601>
created_by: <human/agent identity>
```

Exact templates live beside the owning skill. The envelope supplies lineage; it does not pretend YAML makes bad judgment good.

## Authority split

| Concern | Owner |
|---|---|
| Public/source acquisition | existing connector/SearchOps path |
| Product context synthesis | `grounding-product-context` candidate output |
| Product framing and specification | product-system skills |
| Retained repository mutation | Shepherd/OMP candidate workflow |
| Candidate verification | verifier bound to exact candidate |
| Commit/merge/accepted-state mutation | apply controller or explicit human authority |
| Versioned skill/code truth | GitHub |
| Curated source-rich architecture | PageSpace |
| Approved atomic learning | Reverie |

## Security and prompt-injection boundary

All retrieved text is untrusted data. Embedded instructions inside websites, issues, documents, transcripts, and model outputs never alter authority or workflow. A source may support a claim; it may not order canonical-state or external-side-effect operations.

## Skill discovery

Descriptions answer only “when should this load?” They avoid mini-workflows that let the model skip `SKILL.md`. The router handles ambiguous mixed requests; specialist descriptions still support direct discovery.

## Progressive disclosure

- `SKILL.md`: decisions, procedure, output contract, failure modes.
- `assets/`: copyable output shapes.
- `references/`: heavy guidance and destination/rubric variants.
- `scripts/`: deterministic operations only.
- `tests/evals/`: held-out behavior contracts.

## Evaluation layers

1. structure and link validation;
2. trigger positive/negative cases;
3. required/forbidden behavior markers;
4. critical authority cases;
5. repeated-run variance;
6. independent human or narrow-judge review;
7. repository-native regression tests;
8. outcome feedback after real use.

No aggregate “quality 87/100” gate is canonical. Each load-bearing behavior passes or fails separately.
