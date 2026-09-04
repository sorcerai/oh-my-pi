# ChatPRD Public-Behavior Teardown

**Observed:** 2026-09-03  
**Boundary:** Public pages, public documentation, and public interviews only. No private prompt, source-code, customer-data, or hidden-model access was used.

## Executive verdict

ChatPRD’s useful pattern is not “one excellent PRD prompt.” Its public product surface shows a layered product-work system:

1. retrieve project context from product and engineering systems;
2. identify the requested product artifact or review mode;
3. create or surgically edit a structured document;
4. critique gaps, edge cases, assumptions, rollout, and technical details;
5. preserve project/history context across iterations;
6. hand the result to collaboration, issue, document, or prototyping tools.

The OMP opportunity is to encode those behaviors as modular skills while retaining OMP’s stronger execution and authority controls.

## Publicly observable capability map

| Capability | Public signal | Skill-layer translation |
|---|---|---|
| Context gathering | Homepage demo searches Notion, Linear, and GitHub before drafting. | `grounding-product-context` emits a compact, cited packet. |
| Product document generation | PRDs, one-pagers, user stories, technical specs, and GTM briefs. | `authoring-prds` uses artifact profiles and stable requirement IDs. |
| Custom templates | Team-aligned templates and standards. | Assets are separate from the core skill; project overlays may replace them. |
| Gap and edge-case analysis | Automatic gap analysis and strategic/technical/UX review. | `red-teaming-prds` uses binary gates, severity, and exact patch proposals. |
| Inline editing | Applied edits and suggestions without discarding the whole document. | Existing-document mode emits section patches and preserves untouched content. |
| Versioned project context | Shared projects, history, custom personas. | Context packets and artifact metadata carry source/version/decision lineage. |
| Product-to-work transfer | Linear/GitHub and document exports. | `decomposing-product-work` plus `handing-off-product-work`. |
| Product-to-prototype transfer | v0, Lovable, Bolt, Replit, Cursor integrations. | Destination profiles compress the accepted contract for prototypers. |
| MCP surface | IDE and desktop-app integration. | Handoff envelopes are machine-readable enough for an MCP adapter later. |

## Inferred system shape

The diagram below is an inference from public behavior, not a claim about ChatPRD’s private implementation.

```text
Project sources/connectors
        ↓
Context retrieval + compression
        ↓
Intent/artifact router
        ↓
Template + domain/persona overlay
        ↓
Draft / section edit / review
        ↓
Gap and edge-case gates
        ↓
Versioned artifact + suggestions
        ↓
Export/action adapters
```

## What this pack deliberately does differently

- **No mega-PM prompt.** One skill owns one judgment boundary.
- **No direct autonomous write from external content.** Retrieved sources are evidence, never authority.
- **No “helpfulness” score theater.** Deterministic checks cover structure; narrow binary gates cover judgment.
- **No silent full rewrite during review.** Review is read-only by default and proposes patches.
- **No ticket soup.** Accepted requirements become risk-first vertical slices with traceability.
- **No duplicate control plane.** GitHub/OMP remains canonical; PageSpace and Reverie keep their existing roles.
- **No proprietary copying.** A historical third-party prompt dump was treated as unverified background and excluded from implementation evidence.

## Product moat translated into OMP terms

| Product moat | OMP implementation |
|---|---|
| Specialized PM behavior | Nine discoverable skills with narrow triggers. |
| Persistent context | Source-backed context packet, not an invisible memory blob. |
| Consistent artifact quality | Versioned templates, IDs, deterministic validators, held-out evals. |
| Coaching | Red-team lenses with blockers and patches. |
| Integrations | Explicit destination handoff profiles. |
| Team standards | Replaceable assets and project overlays, not root-prompt bloat. |
| Improvement loop | Skill RED/GREEN/REFACTOR plus promotion evidence. |

## Public sources

- ChatPRD homepage: https://www.chatprd.ai/
- ChatPRD “Claude Skills Explained”: https://www.chatprd.ai/how-i-ai/claude-skills-explained
- ChatPRD documentation entry point: https://www.chatprd.ai/docs

See [SOURCE_MAP.md](SOURCE_MAP.md) for source roles and exclusions.
