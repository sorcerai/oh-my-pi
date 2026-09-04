# Build-Agent Handoff

## Objective

Install and evaluate the product-systems layer without modifying OMP’s root behavior or granting product artifacts authority over repository state.

## Inputs

- `MANIFEST.json`
- `.omp/skills/*/SKILL.md`
- `tests/evals/product-system.json`
- `docs/ADR-0002-product-systems-skill-layer.md`
- `SHA256SUMS.txt`

## Build order

1. Verify archive and manifest.
2. Run static tests.
3. Inspect collisions with existing skill names.
4. Create feature branch.
5. Copy skill folders and support files.
6. Run no-skill baseline cases.
7. Run with-skill cases in fresh contexts.
8. Record outputs and grade narrow contracts.
9. Run repository-native tests.
10. Open PR with evidence; do not merge.

## Definition of done

- changed files match manifest;
- every new skill has trigger evidence;
- negative trigger cases are included;
- required/forbidden behavior results are visible;
- authority cases have zero critical failures;
- exact model/runtime versions are recorded;
- PR names unresolved issues rather than laundering them into “assumptions.”
