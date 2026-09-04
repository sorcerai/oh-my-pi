# Source Map

**As of:** 2026-09-03

## Evidence hierarchy

| Tier | Source | Use in this pack |
|---|---|---|
| A | Public first-party product pages and official documentation | Current product behavior, integration surfaces, skill format. |
| B | Maintainer-owned open repositories and published methods | Reusable implementation and evaluation patterns. |
| C | Practitioner explanation with inspectable examples | Workflow hypotheses and failure modes. |
| D | Unverified prompt dumps or copied summaries | Discovery only; never implementation truth. |

## Sources used

| Source | Tier | What was taken | What was not taken |
|---|---:|---|---|
| ChatPRD homepage — https://www.chatprd.ai/ | A | Context search, document generation, coaching, gap analysis, integrations, team/project behavior. | Private architecture, prompts, models, internal metrics. |
| ChatPRD “Claude Skills Explained” — https://www.chatprd.ai/how-i-ai/claude-skills-explained | A/C | Folder packaging, `SKILL.md`, lean meta-skill, validator limits, executable scripts, real-input iteration. | Any hidden built-in skill contents. |
| Anthropic Agent Skills docs — https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview | A | Progressive disclosure, modular on-demand skills, resource structure, security review. | Claude-only runtime assumptions. |
| Anthropic skill creator — https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator/skills/skill-creator | B | Trigger evals, realistic cases, iterative creation/evaluation, packaging. | Direct copying of proprietary or irrelevant examples. |
| Agent Skills specification — https://agentskills.io/specification | A/B | Portable frontmatter and folder constraints. | Optional fields unsupported by OMP. |
| GitHub Spec Kit — https://github.com/github/spec-kit | B | Constitution/specify/plan/tasks/implement separation and artifact convergence. | CLI installation or wholesale workflow replacement. |
| Basecamp Shape Up — https://basecamp.com/shapeup | B | Problem, appetite, solution sketch, rabbit holes, no-gos. | Fixed six-week cycles as a universal rule. |
| Model Context Protocol architecture — https://modelcontextprotocol.io/docs/learn/architecture | A | Host/client/server boundaries and explicit capability surfaces. | A new MCP server in v1. |
| Existing `sorcerai/oh-my-pi` skills | A for this repository | Natural trigger descriptions, RFC-style load-bearing rules, progressive references/scripts. | Root prompt changes. |
| Existing Constellation authority records | A for Aria’s system | GitHub canonical; PageSpace curated; Reverie atomic; apply authority separated. | Duplicate runtime state. |

## Explicitly excluded

A public third-party repository containing a purported historical ChatPRD GPT prompt was inspected only to understand what *not* to trust. It is unauthenticated, may be stale, and is not evidence of ChatPRD’s current system. No language from it is included as authoritative implementation content.

## Inference labels

- **Observed:** directly visible in first-party product/docs.
- **Inferred:** a plausible architecture needed to explain observed behavior.
- **Adopted:** a deliberate OMP design choice.
- **Excluded:** intentionally not used.
