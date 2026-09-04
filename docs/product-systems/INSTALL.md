# Installation

## From this repository branch

The PR installs the nine skill folders directly under `.omp/skills/`. Verify the branch before running OMP:

```bash
python3 scripts/product-systems/validate_pack.py
python3 -m unittest -v tests/product-systems/test_pack.py
python3 scripts/product-systems/run_eval_contracts.py
```

No root system prompt, command, or tool file is changed. Existing unrelated skills remain in place.

## From the standalone ZIP

The release artifact `omp-product-systems-skill-pack-v1.zip` contains its own safe installer:

```bash
unzip omp-product-systems-skill-pack-v1.zip
cd omp-product-systems-skill-pack-v1
python3 scripts/validate_pack.py
python3 scripts/install.py --target /path/to/oh-my-pi --dry-run
python3 scripts/install.py --target /path/to/oh-my-pi
```

A collision stops the ZIP installer. `--force` backs up only colliding skill directories before replacement. Never blind-copy over existing skills.

## Rollback

Revert the PR or remove only the nine directories listed in `MANIFEST.json`. Do not touch pre-existing OMP skills.
