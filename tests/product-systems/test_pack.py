from __future__ import annotations

import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXPECTED_SKILLS = {
    "routing-product-work",
    "grounding-product-context",
    "shaping-product-bets",
    "authoring-prds",
    "red-teaming-prds",
    "decomposing-product-work",
    "handing-off-product-work",
    "authoring-agent-skills",
    "evaluating-agent-skills",
}
REQUIRED_SECTIONS = {
    "## Overview",
    "## Inputs",
    "## Output contract",
    "## Workflow",
    "## Verification",
    "## Common failures",
}


def load_module(relative_path: str, name: str):
    path = ROOT / relative_path
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PackContractTests(unittest.TestCase):
    def test_expected_skills_exist(self) -> None:
        found = {path.parent.name for path in (ROOT / ".omp" / "skills").glob("*/SKILL.md")}
        self.assertEqual(EXPECTED_SKILLS, found)

    def test_skill_frontmatter_and_required_sections(self) -> None:
        for skill_name in EXPECTED_SKILLS:
            path = ROOT / ".omp" / "skills" / skill_name / "SKILL.md"
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.startswith("---\n"), path)
            self.assertIn(f"name: {skill_name}\n", text, path)
            self.assertIn("description: Use when", text, path)
            self.assertLessEqual(len(text.splitlines()), 500, path)
            for section in REQUIRED_SECTIONS:
                self.assertIn(section, text, f"{path}: missing {section}")

    def test_manifest_matches_skills(self) -> None:
        manifest = json.loads((ROOT / "docs" / "product-systems" / "MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(EXPECTED_SKILLS, set(manifest["skills"]))
        self.assertEqual("omp-product-systems.v1", manifest["schema_version"])
        self.assertEqual("candidate", manifest["promotion_status"])

    def test_validator_passes(self) -> None:
        validator = load_module("scripts/product-systems/validate_pack.py", "validate_pack")
        errors = validator.validate_pack(ROOT)
        self.assertEqual([], errors, "\n".join(errors))

    def test_eval_catalog_has_trigger_and_behavior_coverage(self) -> None:
        catalog = json.loads((ROOT / "tests" / "product-systems" / "evals" / "product-system.json").read_text(encoding="utf-8"))
        cases = catalog["cases"]
        self.assertGreaterEqual(len(cases), 20)
        self.assertEqual({"trigger", "behavior", "authority"}, {c["kind"] for c in cases})
        covered = {c["expected_skill"] for c in cases if c["expected_skill"]}
        self.assertEqual(EXPECTED_SKILLS, covered)
        self.assertTrue(any(not c["should_trigger"] for c in cases))

    def test_contract_grader_rejects_baseline_and_accepts_gold(self) -> None:
        grader = load_module("scripts/product-systems/run_eval_contracts.py", "run_eval_contracts")
        case = {
            "id": "fixture-handoff",
            "required_markers": ["authority", "source_refs", "verification"],
            "forbidden_markers": ["apply directly without review"],
        }
        baseline = (ROOT / "tests" / "product-systems" / "fixtures" / "baseline" / "handoff.md").read_text()
        gold = (ROOT / "tests" / "product-systems" / "fixtures" / "gold" / "handoff.md").read_text()
        self.assertFalse(grader.grade_output(case, baseline)[0])
        self.assertTrue(grader.grade_output(case, gold)[0])


if __name__ == "__main__":
    unittest.main()
