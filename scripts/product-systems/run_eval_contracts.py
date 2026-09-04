#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def grade_output(case: dict[str, Any], output: str) -> tuple[bool, list[str]]:
    lowered = output.casefold()
    failures: list[str] = []
    for marker in case.get("required_markers", []):
        if marker.casefold() not in lowered:
            failures.append(f"missing required marker: {marker}")
    for marker in case.get("forbidden_markers", []):
        if marker.casefold() in lowered:
            failures.append(f"contains forbidden marker: {marker}")
    return not failures, failures


def validate_catalog(catalog: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if catalog.get("schema_version") != "omp-skill-evals.v1":
        errors.append("unexpected schema_version")
    cases = catalog.get("cases")
    if not isinstance(cases, list) or not cases:
        return errors + ["cases must be a non-empty list"]
    required = {
        "id",
        "kind",
        "prompt",
        "expected_skill",
        "should_trigger",
        "required_markers",
        "forbidden_markers",
    }
    ids: set[str] = set()
    for index, case in enumerate(cases):
        missing = required - set(case)
        if missing:
            errors.append(f"case[{index}] missing {sorted(missing)}")
        case_id = case.get("id")
        if not isinstance(case_id, str) or not case_id:
            errors.append(f"case[{index}] invalid id")
        elif case_id in ids:
            errors.append(f"duplicate id: {case_id}")
        else:
            ids.add(case_id)
        if case.get("kind") not in {"trigger", "behavior", "authority"}:
            errors.append(f"{case_id}: invalid kind")
        if not isinstance(case.get("should_trigger"), bool):
            errors.append(f"{case_id}: should_trigger must be boolean")
        for field in ("required_markers", "forbidden_markers"):
            value = case.get(field)
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                errors.append(f"{case_id}: {field} must be string list")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate or grade product-system eval contracts.")
    parser.add_argument(
        "--catalog",
        default=str(ROOT / "tests" / "product-systems" / "evals" / "product-system.json"),
        help="Eval catalog JSON",
    )
    parser.add_argument(
        "--outputs",
        help="Directory containing <case-id>.md model outputs",
    )
    parser.add_argument("--require-all", action="store_true", help="Fail when an output file is missing")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable results")
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    errors = validate_catalog(catalog)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 2

    if not args.outputs:
        print(f"PASS: {len(catalog['cases'])} eval contracts are structurally valid")
        print("LIVE RUN PENDING: provide --outputs after running cases through OMP")
        return 0

    output_root = Path(args.outputs)
    results: list[dict[str, Any]] = []
    failures = 0
    missing = 0
    for case in catalog["cases"]:
        output_path = output_root / f"{case['id']}.md"
        if not output_path.exists():
            missing += 1
            results.append({"id": case["id"], "status": "missing", "failures": []})
            continue
        passed, case_failures = grade_output(case, output_path.read_text(encoding="utf-8"))
        if not passed:
            failures += 1
        results.append({"id": case["id"], "status": "pass" if passed else "fail", "failures": case_failures})

    if args.json:
        print(json.dumps({"results": results, "failed": failures, "missing": missing}, indent=2))
    else:
        for result in results:
            suffix = "" if not result["failures"] else ": " + "; ".join(result["failures"])
            print(f"{result['status'].upper():7} {result['id']}{suffix}")
        print(f"Summary: failed={failures} missing={missing} total={len(results)}")

    if failures or (args.require_all and missing):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
