# Handoff to OMP

Copy the instruction block below into OMP from the unpacked bundle root.

```text
Inspect this product-systems skill pack as a retained candidate. Do not modify the root system prompt, AGENTS.md, existing commands, existing tools, or pre-existing skills.

Source repository: current checkout
Target repository: sorcerai/oh-my-pi or the checked-out OMP fork
Target path: .omp/skills/
Canonical manifest: docs/product-systems/MANIFEST.json
Architecture record: docs/product-systems/ADR-0002-product-systems-skill-layer.md
Eval catalog: tests/product-systems/evals/product-system.json

Required workflow:
1. Verify SHA256SUMS.txt and run:
   python3 scripts/product-systems/validate_pack.py
   python3 -m unittest -v tests/product-systems/test_pack.py
   python3 scripts/product-systems/run_eval_contracts.py
2. Read docs/product-systems/CHATPRD_TEARDOWN.md and docs/product-systems/ARCHITECTURE.md. Treat public product behavior as evidence; never claim access to ChatPRD private prompts, code, data, or model configuration.
3. Inspect every new SKILL.md and its relative references. Preserve progressive disclosure and trigger-only descriptions.
4. Run a true no-skill baseline and then with-skill evaluation using tests/product-systems/evals/product-system.json. Use at least three fresh-context repetitions for trigger cases when the runner permits it. Record model/provider/version, prompt, output, required markers, forbidden markers, and authority violations.
5. Treat deterministic checks as structure evidence only. A skill cannot be promoted because markdown lint passed.
6. Install the nine skills on a feature branch. Existing skill-name collision => stop and produce a merge proposal; never overwrite silently.
7. Re-run repository-native tests plus pack tests. Create a PR containing the skills, docs, eval corpus, and exact validation evidence.
8. Keep the PR unmerged if any critical authority case fails, trigger precision/recall is unmeasured, or live behavior has not been independently reviewed.

Authority:
- You may inspect, test, create a feature branch, retain candidate changes, and open/update a PR.
- You may not push directly to main, merge, mark a decision accepted, or save unreviewed research as approved learning.
- Shepherd/verifier must validate the exact retained candidate. The apply controller retains accepted-state mutation authority.

Return:
- branch and PR;
- changed-file inventory;
- static test evidence;
- live eval matrix with failures and variance;
- unresolved collisions/unknowns;
- promotion recommendation: REJECT | PILOT | PROMOTE.
```

## Expected first run

Use the router on one real mixed request from Aria’s backlog. The correct output is one `ProductRoute`, not a surprise 40-page PRD and a fake Jira backlog summoned from the void.
