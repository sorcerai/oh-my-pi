# Product-System Evals

## Files

- `product-system.json` — held-out trigger, behavior, and authority cases.
- `baseline-structural-red.txt` — the pre-implementation structural RED run.
- `live-run-template.json` — metadata/result envelope for a real OMP/model run.

## Live run

For every case, start a fresh context and record the exact runtime, provider/model/version, available skills, tools, prompt, output path, observed skill invocation, required/forbidden marker result, human label, and notes.

Run ambiguous and high-risk cases at least three times when the runtime permits it. Do not reuse a conversation that has already read the expected answer.

Then grade saved `<case-id>.md` outputs:

```bash
python3 scripts/run_eval_contracts.py --outputs /path/to/outputs --require-all
```

Marker checks are triage, not final judgment. Manually inspect every failure and every match that may only quote a counterexample.
